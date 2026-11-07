/**
 * Aplicar (P6, `docs/SPEC.md` «Escribir»): de las filas marcadas a `vault.notesRewriteBatch`.
 *
 * - Una entrada por NOTA: todos sus arreglos (enlaces y descripción) en un único cuerpo nuevo.
 * - Se relee solo cada nota tocada. Si su hash ya no es el de la revisión, o está protegida, o
 *   ya no existe, no se escribe y la fila dice por qué. La revisión que se manda como esperada
 *   es la de ESA lectura, con `strictRevision: true`: si cambia entre la lectura y la escritura,
 *   el almacén la devuelve en `stale` y no se crea ninguna copia de conflicto.
 * - NUNCA `noteSave`. `touchUpdatedAt: false`. Lotes de 200.
 * - La causa es una por LLAMADA (`notesRewriteBatch` no admite una por nota), así que las notas
 *   se agrupan por causa idéntica y cada grupo se parte en lotes de 200.
 * - `note-locked` tumba el lote entero: se piden los resúmenes, se quitan las protegidas y se
 *   reintenta UNA vez.
 * - La descripción se escribe con `markdown.setProperty` y se comprueba con
 *   `markdown.frontmatter` sobre el cuerpo nuevo; si no sale EXACTA, no se escribe.
 */
import type { PluginMarkdown, PluginNoteRevision, PluginVault } from 'hebra-plugin-api/v2';
import { keyOf, keyString, rewriteLinks, type LinkFix } from '../detect/links';
import { detectOrphans } from '../detect/orphans';
import { analyzeBody } from '../scan/analyze';
import { orphanRowsOf, recordOutcomes, sectionOf, type DescriptionRow, type LinkRow, type Outcome, type ResultsModel } from '../results/model';

export const BATCH_SIZE = 200;
export const READ_CONCURRENCY = 4;
/** La propiedad que se escribe (sin tilde). */
export const DESCRIPTION_KEY = 'descripcion';

export type FailReason = 'changed' | 'locked' | 'gone' | 'unsafe' | 'link-gone' | 'error';

export const DONE_TEXT = 'Hecho';
export const REASON_TEXT: Record<Exclude<FailReason, 'error'>, string> = {
  changed: 'Cambió desde la revisión: no se tocó',
  locked: 'Protegida: no se tocó',
  gone: 'Ya no existe',
  unsafe: 'No se puede escribir la propiedad sin riesgo',
  'link-gone': 'El enlace ya no está en la nota: no se tocó'
};

/** Lo que se usa de `api.markdown` al aplicar. */
export type ApplyMarkdown = Pick<PluginMarkdown, 'links' | 'frontmatter' | 'setProperty'>;

export interface ApplyDeps {
  vault: Pick<PluginVault, 'noteRead' | 'noteSummary' | 'notesRewriteBatch'>;
  markdown: ApplyMarkdown;
  /** ¿Es este error un `note-locked`? (`api.isError(error, 'note-locked')`.) */
  isLockedError(error: unknown): boolean;
  /** Avisan de las escrituras propias (`OwnWrites`). */
  onWriteStart?(ids: readonly string[]): void;
  onWriteEnd?(ids: readonly string[]): void;
}

export interface ApplyReport {
  outcomes: Map<string, Outcome>;
  /** Cambios escritos (apariciones de enlace + descripciones). */
  changes: number;
  /** Notas escritas. */
  notes: number;
  /** Notas que cambiaron entre la revisión y Aplicar (o durante) y no se tocaron. */
  changedMeanwhile: number;
  /** Filas que no se aplicaron por el motivo que sea. */
  failedRows: number;
  /** Llamadas a `notesRewriteBatch` (para los tests y para el resumen). */
  batches: number;
}

interface Plan {
  noteId: string;
  links: LinkRow[];
  description: DescriptionRow | null;
}

interface Entry {
  noteId: string;
  body: string;
  expected: PluginNoteRevision;
  cause: string;
  rows: { id: string; changes: number }[];
}

export const failed = (reason: FailReason, detail?: string): Outcome => ({
  state: 'failed',
  text: reason === 'error' ? `No se pudo escribir: ${detail ?? 'error desconocido'}` : REASON_TEXT[reason]
});
const done: Outcome = { state: 'done', text: DONE_TEXT };

function plansOf(model: ResultsModel): Plan[] {
  const plans = new Map<string, Plan>();
  const planFor = (id: string): Plan => {
    let plan = plans.get(id);
    if (!plan) plans.set(id, (plan = { noteId: id, links: [], description: null }));
    return plan;
  };
  for (const row of sectionOf(model, 'links').rows as LinkRow[]) {
    if (row.checked && row.fix && row.outcome === null) planFor(row.finding.sourceId).links.push(row);
  }
  for (const row of sectionOf(model, 'descriptions').rows as DescriptionRow[]) {
    if (row.checked && row.item.proposal !== null && row.outcome === null) planFor(row.item.id).description = row;
  }
  return [...plans.values()];
}

/** «2 enlaces y descripción». */
export function causeOf(linkChanges: number, description: boolean): string {
  const parts: string[] = [];
  if (linkChanges > 0) parts.push(`${linkChanges} ${linkChanges === 1 ? 'enlace' : 'enlaces'}`);
  if (description) parts.push('descripción');
  return `Mantenimiento: ${parts.join(' y ')}`;
}

/** Escribe la descripción y comprueba el resultado; `null` si no sale exacta. */
function withDescription(markdown: ApplyDeps['markdown'], body: string, proposal: string): string | null {
  try {
    const next = markdown.setProperty(body, DESCRIPTION_KEY, proposal);
    if (next === body) return null;
    return markdown.frontmatter(next)?.[DESCRIPTION_KEY] === proposal ? next : null;
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function applyChecked(model: ResultsModel, deps: ApplyDeps): Promise<ApplyReport> {
  const { vault, markdown } = deps;
  const plans = plansOf(model);
  const outcomes = new Map<string, Outcome>();
  const reviewed = new Map(model.review.scan.notes.map((n) => [n.id, n]));
  const failAll = (plan: Plan, outcome: Outcome): void => {
    for (const row of plan.links) outcomes.set(row.id, outcome);
    if (plan.description) outcomes.set(plan.description.id, outcome);
  };

  // 1. Releer solo las notas tocadas y calcular el cuerpo nuevo de cada una.
  const entries: Entry[] = [];
  const reads = await mapLimit(plans, READ_CONCURRENCY, async (plan) => {
    try {
      return { plan, note: await vault.noteRead(plan.noteId), error: null as string | null };
    } catch (error) {
      return { plan, note: null, error: error instanceof Error ? error.message : String(error) };
    }
  });
  for (const { plan, note, error } of reads) {
    if (error !== null) return failAllWith(plans, error);
    if (note === null) failAll(plan, failed('gone'));
    else if (note.locked || note.body === null) failAll(plan, failed('locked'));
    else if (note.revision.bodySha256 !== reviewed.get(plan.noteId)?.bodySha256) failAll(plan, failed('changed'));
    else {
      const entry = compute(plan, note.body, note.revision, markdown, outcomes);
      if (entry) entries.push(entry);
    }
  }

  // 2. Escribir: por causa, en lotes de 200.
  const byCause = new Map<string, Entry[]>();
  for (const entry of entries) byCause.set(entry.cause, [...(byCause.get(entry.cause) ?? []), entry]);
  const written = new Map<string, { body: string; revision: PluginNoteRevision }>();
  let batches = 0;
  for (const [cause, group] of byCause) {
    for (let start = 0; start < group.length; start += BATCH_SIZE) {
      const chunk = group.slice(start, start + BATCH_SIZE);
      batches += await writeChunk(chunk, cause, deps, outcomes, written);
    }
  }

  // 3. Resultado por fila de las escritas.
  let changes = 0;
  for (const entry of entries) {
    if (!written.has(entry.noteId)) continue;
    for (const row of entry.rows) {
      outcomes.set(row.id, done);
      changes += row.changes;
    }
  }
  recordOutcomes(model, outcomes);
  refreshReview(model, written, markdown);

  const changedNotes = new Set<string>();
  for (const plan of plans) {
    const ids = [...plan.links.map((r) => r.id), ...(plan.description ? [plan.description.id] : [])];
    if (ids.some((id) => outcomes.get(id)?.text === REASON_TEXT.changed)) changedNotes.add(plan.noteId);
  }
  return {
    outcomes,
    changes,
    notes: written.size,
    changedMeanwhile: changedNotes.size,
    failedRows: [...outcomes.values()].filter((o) => o.state === 'failed').length,
    batches
  };

  function failAllWith(all: Plan[], detail: string): ApplyReport {
    for (const plan of all) failAll(plan, failed('error', detail));
    recordOutcomes(model, outcomes);
    return { outcomes, changes: 0, notes: 0, changedMeanwhile: 0, failedRows: outcomes.size, batches: 0 };
  }
}

/** El cuerpo nuevo de una nota con todos sus arreglos; anota en `outcomes` los que no se pueden. */
function compute(
  plan: Plan,
  body: string,
  revision: PluginNoteRevision,
  markdown: ApplyDeps['markdown'],
  outcomes: Map<string, Outcome>
): Entry | null {
  const rows: Entry['rows'] = [];
  let next = body;
  let linkChanges = 0;
  if (plan.links.length > 0) {
    const links = markdown.links(body);
    const counts = new Map<string, number>();
    for (const link of links) {
      if (link.target === null) continue;
      const k = keyString(keyOf({ ...link, target: link.target }));
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const fixes: LinkFix[] = [];
    for (const row of plan.links) {
      const matches = counts.get(keyString(row.finding.key)) ?? 0;
      if (matches === 0 || row.fix === null) {
        outcomes.set(row.id, failed('link-gone'));
        continue;
      }
      fixes.push({ key: row.finding.key, newTarget: row.fix.newTarget, addAlias: row.fix.addAlias });
      rows.push({ id: row.id, changes: matches });
      linkChanges += matches;
    }
    if (fixes.length > 0) next = rewriteLinks(body, links, fixes).body;
  }
  if (plan.description && plan.description.item.proposal !== null) {
    const withProperty = withDescription(markdown, next, plan.description.item.proposal);
    if (withProperty === null) outcomes.set(plan.description.id, failed('unsafe'));
    else {
      next = withProperty;
      rows.push({ id: plan.description.id, changes: 1 });
    }
  }
  if (rows.length === 0 || next === body) return null;
  return { noteId: plan.noteId, body: next, expected: revision, cause: causeOf(linkChanges, rows.some((r) => r.id === plan.description?.id)), rows };
}

/**
 * Una llamada a `notesRewriteBatch` (con el reintento por `note-locked`). Devuelve cuántas
 * llamadas hizo. Rellena `written` y, para lo que no se escribió, `outcomes`.
 */
async function writeChunk(
  chunk: Entry[],
  cause: string,
  deps: ApplyDeps,
  outcomes: Map<string, Outcome>,
  written: Map<string, { body: string; revision: PluginNoteRevision }>
): Promise<number> {
  const { vault } = deps;
  const failEntries = (list: readonly Entry[], outcome: Outcome): void => {
    for (const entry of list) for (const row of entry.rows) outcomes.set(row.id, outcome);
  };
  const toRewrite = (list: readonly Entry[]) =>
    list.map((e) => ({ id: e.noteId, body: e.body, expected: e.expected, strictRevision: true as const }));
  const ids = chunk.map((e) => e.noteId);
  let calls = 0;
  let pending = chunk;
  deps.onWriteStart?.(ids);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        calls += 1;
        const result = await vault.notesRewriteBatch(toRewrite(pending), { cause, touchUpdatedAt: false });
        const committed = new Map(result.committed.map((c) => [c.id, c]));
        for (const id of result.written) {
          const c = committed.get(id);
          const entry = pending.find((e) => e.noteId === id);
          if (c) written.set(id, { body: c.body, revision: c.revision });
          else if (entry) written.set(id, { body: entry.body, revision: entry.expected });
        }
        const missing = new Set(result.missing ?? []);
        const stale = pending.filter((e) => result.stale.includes(e.noteId));
        failEntries(stale.filter((e) => missing.has(e.noteId)), failed('gone'));
        const changed = stale.filter((e) => !missing.has(e.noteId));
        await explainStale(changed, vault, outcomes);
        return calls;
      } catch (error) {
        if (!deps.isLockedError(error) || attempt === 1) {
          failEntries(pending, failed('error', error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error)));
          return calls;
        }
        // Una protegida tumba el lote entero: quitarlas y reintentar UNA vez.
        const summaries = await vault.noteSummary(pending.map((e) => e.noteId));
        const known = new Map(summaries.map((s) => [s.id, s]));
        failEntries(pending.filter((e) => known.get(e.noteId)?.locked === true), failed('locked'));
        failEntries(pending.filter((e) => !known.has(e.noteId) || known.get(e.noteId)!.trashedAt !== null), failed('gone'));
        pending = pending.filter((e) => known.has(e.noteId) && !known.get(e.noteId)!.locked && known.get(e.noteId)!.trashedAt === null);
        if (pending.length === 0) return calls;
      }
    }
    return calls;
  } finally {
    deps.onWriteEnd?.(ids);
  }
}

/** Las devueltas en `stale`: ¿cambiaron, se protegieron o desaparecieron? */
async function explainStale(entries: readonly Entry[], vault: ApplyDeps['vault'], outcomes: Map<string, Outcome>): Promise<void> {
  if (entries.length === 0) return;
  let known: Map<string, { locked: boolean; trashedAt: number | null }> | null = null;
  try {
    known = new Map((await vault.noteSummary(entries.map((e) => e.noteId))).map((s) => [s.id, s]));
  } catch {
    // Sin resumen, lo más probable (y lo más prudente de decir) es que cambió.
  }
  for (const entry of entries) {
    const s = known?.get(entry.noteId);
    let outcome = failed('changed');
    if (known !== null && s === undefined) outcome = failed('gone');
    else if (s?.locked) outcome = failed('locked');
    else if (s && s.trashedAt !== null) outcome = failed('gone');
    for (const row of entry.rows) outcomes.set(row.id, outcome);
  }
}

/**
 * Tras escribir: las notas tocadas se vuelven a analizar con el cuerpo que Hebra confirmó (sin
 * releerlas) y se recalcula «Sin enlaces entrantes», que es lo único que un arreglo de enlaces
 * puede cambiar en las demás secciones.
 */
function refreshReview(
  model: ResultsModel,
  written: ReadonlyMap<string, { body: string; revision: PluginNoteRevision }>,
  markdown: ApplyDeps['markdown']
): void {
  if (written.size === 0) return;
  const { scan } = model.review;
  scan.notes = scan.notes.map((note) => {
    const w = written.get(note.id);
    if (!w) return note;
    return { ...note, bodySha256: w.revision.bodySha256, analysis: analyzeBody(markdown, w.revision.bodySha256, w.body) };
  });
  model.review.orphans = detectOrphans(scan);
  sectionOf(model, 'orphans').rows = orphanRowsOf(model.review);
}
