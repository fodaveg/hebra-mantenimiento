/**
 * Detector de enlaces (puntos 1 y 2 de `docs/SPEC.md`): resuelve cada enlace del recorrido con
 * el criterio de la app, lo clasifica (bien, sin destino, ambiguo, no juzgado), busca candidatos
 * para los que no tienen destino (R1 renombrados, R2 sin acentos ni puntuación, R3 prefijo JD),
 * decide si el arreglo va marcado y construye el texto nuevo del enlace. `rewriteLinks` aplica
 * los arreglos sobre un cuerpo real (P6 lo llama; aquí es una función pura).
 *
 * Todo es puro salvo `detectLinks`, que consulta el registro de renombrados (asíncrono).
 */
import type { PluginFolder, PluginMarkdownLink } from 'hebra-plugin-api/v2';
import { jdPrefixOf } from './jd';
import type { LinkRef, ScannedNote, ScanResult } from '../scan/types';

/** Un título de más de 200 caracteres llega recortado a un plugin: no se juzga. */
export const MAX_JUDGED_TITLE = 200;

export type LinkStatus = 'ok' | 'broken' | 'ambiguous' | 'skipped';

type Judged = Pick<LinkRef, 'target' | 'targetPath' | 'targetKind'>;

/** NFKC, recortado y en minúsculas: el título canónico de la app (no quita acentos). */
export function canonical(text: string): string {
  return text.normalize('NFKC').trim().toLowerCase();
}

/** R2: sin acentos, mayúsculas, espacios repetidos ni signos de puntuación. */
export function foldTitle(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Qué enlace es «el mismo» dentro de una nota: mismo destino, sin mirar alias ni encabezado. */
export interface LinkKey {
  targetKind: string;
  target: string;
  targetPath: string | null;
}

export const keyOf = (link: Judged & { target: string }): LinkKey => ({
  targetKind: link.targetKind,
  target: link.target,
  targetPath: link.targetPath
});
export const keyString = (key: LinkKey): string => `${key.targetKind}\u0000${key.target}\u0000${key.targetPath ?? ''}`;

// ---- índice de la biblioteca ----

export interface LinkIndex {
  notes: readonly ScannedNote[];
  byId: Map<string, ScannedNote>;
  byTitle: Map<string, ScannedNote[]>;
  byFold: Map<string, ScannedNote[]>;
  /** Carpetas desde la raíz hasta la de la nota, con su nombre exacto. */
  folderNames(note: ScannedNote): string[];
}

const push = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

export function buildLinkIndex(scan: Pick<ScanResult, 'notes' | 'folders'>): LinkIndex {
  const folders = new Map<string, PluginFolder>(scan.folders.map((f) => [f.id, f]));
  const byId = new Map<string, ScannedNote>();
  const byTitle = new Map<string, ScannedNote[]>();
  const byFold = new Map<string, ScannedNote[]>();
  for (const note of scan.notes) {
    byId.set(note.id, note);
    push(byTitle, canonical(note.title), note);
    push(byFold, foldTitle(note.title), note);
  }
  const folderNames = (note: ScannedNote): string[] => {
    const names: string[] = [];
    const seen = new Set<string>();
    for (let id: string | null = note.folderId; id !== null && !seen.has(id); ) {
      seen.add(id);
      const folder = folders.get(id);
      if (!folder) break;
      names.unshift(folder.name);
      id = folder.parentId;
    }
    return names;
  };
  return { notes: scan.notes, byId, byTitle, byFold, folderNames };
}

// ---- punto 1: resolver ----

/** Como Hebra: `trim().toLowerCase()` SIN NFKC en los segmentos de carpeta (M3). */
const lastSegments = (names: string[]): string[] => names.map((n) => n.trim().toLowerCase());

/** ¿Acaban los segmentos de carpeta de la nota en la ruta del enlace? */
function pathMatches(index: LinkIndex, note: ScannedNote, path: string): boolean {
  const wanted = path.split('/');
  const have = lastSegments(index.folderNames(note));
  if (have.length < wanted.length) return false;
  return wanted.every((segment, i) => have[have.length - wanted.length + i] === segment);
}

export interface Resolution {
  status: LinkStatus;
  candidates: ScannedNote[];
}

export function resolveLink(index: LinkIndex, link: Judged): Resolution {
  const kind = link.targetKind;
  if ((kind !== 'note-title' && kind !== 'note-path' && kind !== 'note-id') || link.target === null) {
    return { status: 'skipped', candidates: [] };
  }
  if (link.target.length > MAX_JUDGED_TITLE) return { status: 'skipped', candidates: [] };
  let found: ScannedNote[];
  if (kind === 'note-id') {
    const note = index.byId.get(link.target);
    found = note ? [note] : [];
  } else {
    found = index.byTitle.get(link.target) ?? [];
    // La ruta solo desempata entre varias notas con ese título.
    if (found.length > 1 && link.targetPath !== null) {
      const path = link.targetPath;
      const narrowed = found.filter((note) => pathMatches(index, note, path));
      if (narrowed.length > 0) found = narrowed;
    }
  }
  if (found.length === 0) return { status: 'broken', candidates: [] };
  return { status: found.length === 1 ? 'ok' : 'ambiguous', candidates: found };
}

// ---- punto 2: candidatos ----

export type CandidateReason = 'R1' | 'R2' | 'R3';

export interface Candidate {
  note: ScannedNote;
  /** Por qué regla llegó (vacío en un enlace ambiguo: ya casaba por título). */
  reasons: CandidateReason[];
  /** Es una copia de conflicto: se etiqueta y nunca va marcada. */
  conflictCopy: boolean;
  /** Reescribir el enlace a esta nota cambiaría el número JD escrito en él. */
  changesJdNumber: boolean;
  /** Ruta de carpetas para enseñarla (`Proyectos/2027`). */
  folderPath: string;
}

const candidateOf = (index: LinkIndex, note: ScannedNote, reasons: CandidateReason[], changesJdNumber: boolean): Candidate => ({
  note,
  reasons,
  conflictCopy: note.conflictOf !== null,
  changesJdNumber,
  folderPath: index.folderNames(note).join('/')
});

/** Lo que dice `parseTarget` del texto de un destino, como lo analiza Hebra. */
export function parseTarget(text: string): Judged {
  const ref = text.trim();
  if (ref === '') return { target: null, targetPath: null, targetKind: 'empty' };
  if (/^(?:task|list):/u.test(ref)) return { target: null, targetPath: null, targetKind: 'lumbre' };
  if (/^\{\{[^{}]*\}\}$/u.test(ref)) return { target: null, targetPath: null, targetKind: 'template' };
  if (ref.startsWith('id:')) {
    const id = ref.slice(3).trim();
    return { target: id || null, targetPath: null, targetKind: id ? 'note-id' : 'empty' };
  }
  const slash = ref.lastIndexOf('/');
  const name = ref.slice(slash + 1).trim();
  const targetPath =
    slash < 0
      ? null
      : ref
          .slice(0, slash)
          .split('/')
          .map((segment) => segment.trim().toLowerCase())
          .filter(Boolean)
          .join('/') || null;
  const extension = /\.([^.\s/]{1,8})$/u.exec(name);
  const hasLetters = extension !== null && /\p{L}/u.test(extension[1]);
  if (!name) return { target: null, targetPath: null, targetKind: 'empty' };
  if (hasLetters && extension[1].toLowerCase() !== 'md') {
    return { target: name, targetPath: null, targetKind: 'file' };
  }
  const title = canonical(hasLetters ? name.slice(0, -3) : name);
  return { target: title, targetPath, targetKind: targetPath === null ? 'note-title' : 'note-path' };
}

/** Caracteres que rompen un wikilink o cambian cómo se lee su destino. */
/** (`%%` abre un comentario y esconde los enlaces que siguen: B3 de la revisión.) */
const UNSAFE_IN_TARGET = /[[\]|#^\n\r]|%%/;

export interface PlannedFix {
  /** El texto nuevo del destino (solo el destino: sin `!`, alias ni encabezado). */
  newTarget: string;
  /** Si el enlace no tenía alias, se añade el texto que se veía (porque se añadió ruta). */
  addAlias: boolean;
  /** Volver a resolver el enlace reescrito da esa nota y solo esa. */
  resolvesToOnlyTarget: boolean;
}

/**
 * El destino nuevo para apuntar a `note`: su título, y si lo comparten varias notas, la ruta de
 * carpetas MÁS CORTA que lo deja único (comprobado resolviendo el texto resultante). `null` si
 * el título no se puede escribir en un enlace o ninguna ruta lo desambigua.
 */
export function planFix(index: LinkIndex, note: ScannedNote): PlannedFix | null {
  if (UNSAFE_IN_TARGET.test(note.title) || note.title.trim() === '') return null;
  const title = note.title.trim();
  const resolvesToNote = (text: string): boolean => {
    const resolution = resolveLink(index, parseTarget(text));
    return resolution.status === 'ok' && resolution.candidates[0] === note;
  };
  if (resolvesToNote(title)) return { newTarget: title, addAlias: false, resolvesToOnlyTarget: true };
  const names = index.folderNames(note);
  for (let depth = 1; depth <= names.length; depth += 1) {
    const text = `${names.slice(names.length - depth).join('/')}/${title}`;
    if (names.slice(names.length - depth).some((n) => UNSAFE_IN_TARGET.test(n) || n.includes('/'))) continue;
    if (resolvesToNote(text)) return { newTarget: text, addAlias: true, resolvesToOnlyTarget: true };
  }
  return null;
}

export interface LinkFinding {
  /** Estable dentro de una revisión: nota de origen + enlace. */
  id: string;
  sourceId: string;
  sourceTitle: string;
  link: LinkRef & { target: string };
  key: LinkKey;
  status: 'broken' | 'ambiguous';
  /** Cuántas veces aparece este enlace en la nota (se reescriben juntas). */
  occurrences: number;
  candidates: Candidate[];
  /** El arreglo propuesto cuando hay un único candidato; `null` si no hay arreglo posible. */
  fix: PlannedFix | null;
  /** Va marcado (solo seguro: único destino, no copia, sin cambiar número JD, re-resolución única). */
  checked: boolean;
}

export type RenameLookup = (canonicalTitle: string) => Promise<string | null>;

function brokenCandidates(
  index: LinkIndex,
  link: Judged & { target: string },
  renamedTo: string | null
): Candidate[] {
  const found = new Map<string, { note: ScannedNote; reasons: Set<CandidateReason>; jd: boolean }>();
  const add = (note: ScannedNote, reason: CandidateReason, jd = false): void => {
    const entry = found.get(note.id);
    if (entry) {
      entry.reasons.add(reason);
      entry.jd = entry.jd || jd;
    } else found.set(note.id, { note, reasons: new Set([reason]), jd });
  };
  const wanted = link.target;
  // R1: fue renombrada desde ese título en este dispositivo.
  if (link.targetKind !== 'note-id' && renamedTo !== null) {
    const note = index.byId.get(renamedTo);
    if (note && canonical(note.title) !== wanted) add(note, 'R1');
  }
  if (link.targetKind !== 'note-id') {
    // R2: mismo título sin acentos, mayúsculas, espacios repetidos ni puntuación.
    for (const note of index.byFold.get(foldTitle(wanted)) ?? []) add(note, 'R2');
    // R3: prefijo JD delante (el enlace no lleva número), o el mismo texto con OTRO número.
    const own = jdPrefixOf(wanted);
    for (const note of index.notes) {
      const prefix = jdPrefixOf(note.title);
      if (!prefix) continue;
      if (own === null && canonical(prefix.title) === wanted) add(note, 'R3');
      else if (own !== null && own.title !== '' && canonical(prefix.title) === own.title && prefix.number !== own.number) {
        add(note, 'R3', true);
      }
    }
  }
  return [...found.values()]
    .map((e) => candidateOf(index, e.note, [...e.reasons].sort() as CandidateReason[], e.jd || changesJd(wanted, e.note)))
    .sort((a, b) => a.note.title.localeCompare(b.note.title) || a.note.id.localeCompare(b.note.id));
}

/** ¿Escribir esta nota como destino cambiaría el número JD que ya trae el enlace? */
function changesJd(wanted: string, note: ScannedNote): boolean {
  const own = jdPrefixOf(wanted);
  if (own === null) return false;
  const next = jdPrefixOf(note.title);
  return next === null || next.number !== own.number;
}

/**
 * Los hallazgos de enlaces de un recorrido: uno por (nota, destino) roto o ambiguo. Las notas
 * protegidas no tienen derivado (no se leyeron) y por tanto no aportan enlaces.
 */
export async function detectLinks(
  scan: Pick<ScanResult, 'notes' | 'folders'>,
  lookupRename: RenameLookup = () => Promise.resolve(null)
): Promise<LinkFinding[]> {
  const index = buildLinkIndex(scan);
  const renameCache = new Map<string, string | null>();
  const renamed = async (title: string): Promise<string | null> => {
    if (!renameCache.has(title)) renameCache.set(title, await lookupRename(title));
    return renameCache.get(title) ?? null;
  };
  const findings: LinkFinding[] = [];
  for (const source of scan.notes) {
    if (source.locked || source.analysis === null) continue;
    const groups = new Map<string, { link: LinkRef & { target: string }; count: number; image: boolean }>();
    for (const link of source.analysis.links) {
      if (link.target === null) continue;
      const withTarget = { ...link, target: link.target };
      const resolution = resolveLink(index, withTarget);
      if (resolution.status === 'ok' || resolution.status === 'skipped') continue;
      const key = keyString(keyOf(withTarget));
      const group = groups.get(key);
      if (group) {
        group.count += 1;
        group.image = group.image || link.kind === 'image';
      } else groups.set(key, { link: withTarget, count: 1, image: link.kind === 'image' });
    }
    for (const [key, { link, count, image }] of groups) {
      const resolution = resolveLink(index, link);
      const base = { id: `${source.id}\u0000${key}`, sourceId: source.id, sourceTitle: source.title, link, key: keyOf(link), occurrences: count };
      if (resolution.status === 'ambiguous') {
        // Ya casaba por título con varias: se enseñan sin marcar; al elegir una se planifica.
        const candidates = resolution.candidates
          .map((note) => candidateOf(index, note, [], false))
          .sort((a, b) => a.folderPath.localeCompare(b.folderPath) || a.note.id.localeCompare(b.note.id));
        findings.push({ ...base, status: 'ambiguous', candidates, fix: null, checked: false });
        continue;
      }
      const candidates = brokenCandidates(index, link, link.targetKind === 'note-id' ? null : await renamed(link.target));
      const only = candidates.length === 1 ? candidates[0] : null;
      let fix = only ? planFix(index, only.note) : null;
      // N2: en `![alt](destino)` un paréntesis del destino rompe el enlace.
      if (fix && image && /[()]/.test(fix.newTarget)) fix = null;
      const checked =
        only !== null && fix !== null && fix.resolvesToOnlyTarget && !only.conflictCopy && !only.changesJdNumber;
      findings.push({ ...base, status: 'broken', candidates, fix, checked });
    }
  }
  return findings;
}

// ---- reescribir ----

export interface LinkFix {
  /** El destino a reescribir, como lo dio `markdown.links` del cuerpo vivo. */
  key: LinkKey;
  /** Destino nuevo (solo el destino). */
  newTarget: string;
  /** Añadir el texto visto antes como alias si el enlace no tenía alias. */
  addAlias: boolean;
}

export interface RewriteEdit {
  /** Posición en el cuerpo ORIGINAL. */
  at: number;
  remove: number;
  text: string;
}

export interface RewriteResult {
  body: string;
  /** Apariciones reescritas. */
  rewritten: number;
  /** Las ediciones aplicadas (en coordenadas del cuerpo original), para verificar el resultado. */
  edits: RewriteEdit[];
}

/** El texto que Hebra enseña de un destino: el último segmento de la ruta, sin `.md` (N3). */
export function visibleText(rawTarget: string): string {
  const name = rawTarget.trim().slice(rawTarget.trim().lastIndexOf('/') + 1);
  return name.replace(/\.md$/i, '').trim();
}

/**
 * Reescribe en `body` los enlaces de `links` (la salida de `markdown.links(body)` sobre ESE
 * mismo cuerpo) cuyo destino coincide con alguno de `fixes`. Solo cambia el rango del destino
 * (conserva `!`, alias, encabezado y bloque); con `addAlias` y sin alias, añade `|texto visible`.
 * `aliasSeparator` es `|` (por defecto) o `\|` dentro de una tabla: quien llama lo elige
 * verificando el resultado con `markdown.links`, porque la regla de tabla es de Hebra. Todas las
 * apariciones se reescriben juntas. Un enlace cuyo rango ya no coincide con su `rawTarget` se
 * deja como está.
 */
export function rewriteLinks(
  body: string,
  links: readonly PluginMarkdownLink[],
  fixes: readonly LinkFix[],
  options: { aliasSeparator?: '|' | '\\|' | ((link: PluginMarkdownLink) => '|' | '\\|') } = {}
): RewriteResult {
  const separatorOf = (link: PluginMarkdownLink): '|' | '\\|' =>
    typeof options.aliasSeparator === 'function' ? options.aliasSeparator(link) : (options.aliasSeparator ?? '|');
  const byKey = new Map(fixes.map((fix) => [keyString(fix.key), fix]));
  const edits: RewriteEdit[] = [];
  let rewritten = 0;
  for (const link of links) {
    if (link.target === null) continue;
    const fix = byKey.get(keyString(keyOf({ ...link, target: link.target })));
    if (!fix) continue;
    if (body.slice(link.targetFrom, link.targetTo) !== link.rawTarget) continue;
    edits.push({ at: link.targetFrom, remove: link.targetTo - link.targetFrom, text: fix.newTarget });
    if (fix.addAlias && link.alias === null && link.kind !== 'image' && body.slice(link.to - 2, link.to) === ']]') {
      edits.push({ at: link.to - 2, remove: 0, text: `${separatorOf(link)}${visibleText(link.rawTarget)}` });
    }
    rewritten += 1;
  }
  let out = body;
  for (const edit of [...edits].sort((a, b) => b.at - a.at)) {
    out = out.slice(0, edit.at) + edit.text + out.slice(edit.at + edit.remove);
  }
  return { body: out, rewritten, edits };
}
