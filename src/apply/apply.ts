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
import { canonical, keyOf, keyString, rewriteLinks, visibleText, type LinkFix } from '../detect/links';
import { detectOrphans } from '../detect/orphans';
import { writeDescription } from '../detect/write';
import { analyzeBody } from '../scan/analyze';
import { verifyRewrite } from './verify';
import { orphanRowsOf, recordOutcomes, sectionOf, type DescriptionRow, type LinkRow, type Outcome, type ResultsModel } from '../results/model';

export const BATCH_SIZE = 200;
export const READ_CONCURRENCY = 4;

export type FailReason = 'changed' | 'locked' | 'gone' | 'unsafe' | 'link-gone' | 'unverified' | 'title' | 'error';

export const DONE_TEXT = 'Hecho';
export const REASON_TEXT: Record<Exclude<FailReason, 'error'>, string> = {
  changed: 'Cambió desde la revisión: no se tocó',
  locked: 'Protegida: no se tocó',
  gone: 'Ya no existe',
  unsafe: 'No se puede escribir la propiedad sin riesgo',
  'link-gone': 'El enlace ya no está en la nota: no se tocó',
  unverified: 'No se pudo verificar el cambio: no se tocó',
  title: 'El enlace está en el título de la nota: no se tocó'
};

/** Lo que se usa de `api.markdown` al aplicar. */
export type ApplyMarkdown = Pick<PluginMarkdown, 'links' | 'frontmatter' | 'frontmatterRange' | 'setProperty'>;

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
    if (error !== null) failAll(plan, failed('error', error));
    else if (note === null || note.trashedAt !== null) failAll(plan, failed('gone'));
    else if (note.locked || note.body === null) failAll(plan, failed('locked'));
    else if (note.revision.bodySha256 !== reviewed.get(plan.noteId)?.bodySha256) failAll(plan, failed('changed'));
    else {
      const entry = compute(plan, note.body, note.revision, reviewed.get(plan.noteId)?.title ?? '', markdown, outcomes);
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
      try {
        batches += await writeChunk(chunk, cause, deps, outcomes, written);
      } catch (error) {
        // Lo ya escrito sigue contando; este lote queda como error y se sigue con los demás (M4).
        for (const entry of chunk) {
          if (written.has(entry.noteId)) continue;
          for (const row of entry.rows) outcomes.set(row.id, failed('error', error instanceof Error ? error.message : String(error)));
        }
      }
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
}

/** ¿La línea de este enlace es la que da el título a la nota (un H1 sin `title:` en el frontmatter)? */
function inTitleLine(body: string, from: number, title: string, hasTitleProperty: boolean): boolean {
  if (hasTitleProperty) return false;
  const start = body.lastIndexOf('\n', from - 1) + 1;
  const end = body.indexOf('\n', from);
  const line = body.slice(start, end < 0 ? body.length : end).replace(/\r$/, '');
  const heading = /^ {0,3}#\s+(.*?)\s*#*$/.exec(line);
  return heading !== null && canonical(heading[1]) === canonical(title);
}

/** El cuerpo nuevo de una nota con todos sus arreglos; anota en `outcomes` los que no se pueden. */
function compute(
  plan: Plan,
  body: string,
  revision: PluginNoteRevision,
  title: string,
  markdown: ApplyDeps['markdown'],
  outcomes: Map<string, Outcome>
): Entry | null {
  const links = markdown.links(body);
  const counts = new Map<string, number>();
  const titled = new Set<string>();
  const hasTitleProperty = markdown.frontmatter(body)?.title !== undefined;
  for (const link of links) {
    if (link.target === null) continue;
    const k = keyString(keyOf({ ...link, target: link.target }));
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if (inTitleLine(body, link.from, title, hasTitleProperty)) titled.add(k);
  }
  const rows: Entry['rows'] = [];
  const fixes: LinkFix[] = [];
  let linkChanges = 0;
  for (const row of plan.links) {
    const k = keyString(row.finding.key);
    const matches = counts.get(k) ?? 0;
    if (matches === 0 || row.fix === null) outcomes.set(row.id, failed('link-gone'));
    else if (titled.has(k)) outcomes.set(row.id, failed('title'));
    else {
      fixes.push({ key: row.finding.key, newTarget: row.fix.newTarget, addAlias: row.fix.addAlias });
      rows.push({ id: row.id, changes: matches });
      linkChanges += matches;
    }
  }
  const proposal = plan.description?.item.proposal ?? null;
  const wantsDescription = plan.description !== null && proposal !== null;
  if (fixes.length === 0 && !wantsDescription) return null;

  // Separador del alias: Hebra lee `\|` como separador solo DENTRO de una tabla (y `|` suelto en
  // una celda la parte, cosa que `markdown.links` no ve). La regla no está en la API, así que se
  // sondea: se reescribe con `\|` y se mira qué enlaces vuelve a leer Hebra enteros (destino y
  // alias esperados); esos están en una tabla y llevan `\|`, los demás `|`. La verificación final
  // da por mala la nota entera si algo no cuadra.
  let tableLinks = new Set<number>();
  if (fixes.some((f) => f.addAlias)) {
    const probe = rewriteLinks(body, links, fixes, { aliasSeparator: '\\|' });
    const reread = markdown.links(probe.body);
    if (reread.length === links.length) {
      const byKey = new Map(fixes.map((f) => [keyString(f.key), f]));
      tableLinks = new Set(
        links.flatMap((link, i) => {
          const fix = link.target === null ? undefined : byKey.get(keyString(keyOf({ ...link, target: link.target })));
          if (!fix?.addAlias || link.alias !== null || link.kind === 'image') return [];
          const got = reread[i];
          return got.rawTarget === fix.newTarget && got.alias === visibleText(link.rawTarget) ? [link.from] : [];
        })
      );
    }
  }
  let chosen: { next: string; descriptionOk: boolean } | null = null;
  {
    const rewritten =
      fixes.length > 0
        ? rewriteLinks(body, links, fixes, { aliasSeparator: (link) => (tableLinks.has(link.from) ? '\\|' : '|') })
        : { body, edits: [], rewritten: 0 };
    let next = rewritten.body;
    let descriptionOk = false;
    if (wantsDescription) {
      const withProperty = writeDescription(markdown, next, proposal);
      if (withProperty !== null) {
        next = withProperty;
        descriptionOk = true;
      }
    }
    // Todo lo que sigue al frontmatter se desplaza lo que creció el cuerpo: `writeDescription` ya
    // garantiza que el texto tras el frontmatter no cambia. (Con `frontmatterRange(...).end` salía
    // corto: el `setProperty` real añade una línea en blanco tras el `---` que el rango no cuenta.)
    const baseShift = descriptionOk ? next.length - rewritten.body.length : 0;
    if (verifyRewrite(links, markdown.links(next), fixes, rewritten.edits, baseShift)) chosen = { next, descriptionOk };
  }
  if (chosen === null) {
    for (const row of rows) outcomes.set(row.id, failed('unverified'));
    if (plan.description) outcomes.set(plan.description.id, failed('unverified'));
    return null;
  }
  if (wantsDescription) {
    if (chosen.descriptionOk) rows.push({ id: plan.description!.id, changes: 1 });
    else outcomes.set(plan.description!.id, failed('unsafe'));
  }
  if (rows.length === 0 || chosen.next === body) return null;
  return { noteId: plan.noteId, body: chosen.next, expected: revision, cause: causeOf(linkChanges, chosen.descriptionOk), rows };
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
        let summaries: Awaited<ReturnType<typeof vault.noteSummary>>;
        try {
          summaries = await vault.noteSummary(pending.map((e) => e.noteId));
        } catch (summaryError) {
          failEntries(pending, failed('error', summaryError instanceof Error ? summaryError.message : String(summaryError)));
          return calls;
        }
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
