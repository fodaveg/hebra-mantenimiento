/**
 * El modelo de la pestaña de resultados (P5): las filas de cada sección con su estado
 * (casilla, candidato elegido) y los recuentos. Puro: no toca el DOM ni la API, así que se
 * prueba sin pintar nada. `view.ts` lo pinta y lo muta solo a través de estas funciones.
 */
import type { PluginFolder } from 'hebra-plugin-api/v2';
import { detectMissingDescription, type MissingDescription } from '../detect/description';
import { detectDuplicateFolders, type DuplicateFolderGroup } from '../detect/folders';
import { buildLinkIndex, detectLinks, planFix, type LinkFinding, type LinkIndex, type PlannedFix, type RenameLookup } from '../detect/links';
import { detectOrphans, type OrphanFolderGroup, type OrphanNote } from '../detect/orphans';
import type { ScanResult } from '../scan/types';
import { formatCount } from './format';

/** Lo que devuelve una revisión completa: el recorrido y lo que encontraron los detectores. */
export interface ReviewData {
  scan: ScanResult;
  index: LinkIndex;
  links: LinkFinding[];
  descriptions: MissingDescription[];
  duplicates: DuplicateFolderGroup[];
  orphans: OrphanFolderGroup[];
}

export async function analyze(scan: ScanResult, lookupRename?: RenameLookup): Promise<ReviewData> {
  return {
    scan,
    index: buildLinkIndex(scan),
    links: await detectLinks(scan, lookupRename),
    descriptions: detectMissingDescription(scan),
    duplicates: detectDuplicateFolders(scan.folders),
    orphans: detectOrphans(scan)
  };
}

/** Lo que pasó con una fila al aplicar. */
export interface Outcome {
  state: 'done' | 'failed';
  /** El texto que enseña la fila («Hecho» o el motivo). */
  text: string;
}

export interface LinkRow {
  kind: 'link';
  id: string;
  group: string;
  finding: LinkFinding;
  /** El candidato elegido (o el único); `null` mientras no se elige. */
  chosen: string | null;
  /** El arreglo para el candidato elegido; `null` si no hay (o no se ha elegido). */
  fix: PlannedFix | null;
  checked: boolean;
  /** Elegido y sin arreglo posible (el título no se puede escribir en un enlace). */
  unwritable: boolean;
  outcome: Outcome | null;
  /** La fila se ha pintado alguna vez (la persona ha podido verla). */
  seen: boolean;
}
export interface DescriptionRow {
  kind: 'description';
  id: string;
  group: string;
  item: MissingDescription;
  checked: boolean;
  outcome: Outcome | null;
  seen: boolean;
}
export interface FolderRow {
  kind: 'folder';
  id: string;
  group: string;
  duplicate: DuplicateFolderGroup;
}
export interface OrphanRow {
  kind: 'orphan';
  id: string;
  group: string;
  note: OrphanNote;
}
export type Row = LinkRow | DescriptionRow | FolderRow | OrphanRow;

export type SectionId = 'links' | 'descriptions' | 'folders' | 'orphans';
export interface Section {
  id: SectionId;
  rows: Row[];
  /** `heading`: cada grupo con su título; `folded`: grupos plegados; `none`: lista plana. */
  grouping: 'heading' | 'folded' | 'none';
}

export interface ResultsModel {
  review: ReviewData;
  sections: Section[];
}

/** La ruta de una carpeta con los nombres exactos; la raíz (y lo que no está) es «Biblioteca». */
export function folderPath(folders: readonly PluginFolder[], folderId: string): string {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const names: string[] = [];
  const seen = new Set<string>();
  for (let id: string | null = folderId; id !== null && !seen.has(id); ) {
    seen.add(id);
    const folder = byId.get(id);
    if (!folder) break;
    names.unshift(folder.name);
    id = folder.parentId;
  }
  return names.length > 0 ? names.join('/') : 'Biblioteca';
}

/** Las filas de «Sin enlaces entrantes», ordenadas por carpeta. */
export function orphanRowsOf(review: ReviewData): OrphanRow[] {
  const rows = review.orphans.flatMap((group) =>
    group.notes.map((note): OrphanRow => ({ kind: 'orphan', id: note.id, group: folderPath(review.scan.folders, group.folderId), note }))
  );
  return rows.sort((a, b) => a.group.localeCompare(b.group));
}

export function buildModel(review: ReviewData): ResultsModel {
  const { scan } = review;
  const noteFolder = new Map(scan.notes.map((n) => [n.id, n.folderId]));
  const pathOf = (folderId: string): string => folderPath(scan.folders, folderId);
  const links: LinkRow[] = review.links.map((finding) => {
    const only = finding.candidates.length === 1 ? finding.candidates[0] : null;
    const usable = finding.status === 'broken' && only !== null && finding.fix !== null;
    return {
      kind: 'link',
      id: finding.id,
      group: pathOf(noteFolder.get(finding.sourceId) ?? ''),
      finding,
      chosen: finding.status === 'broken' && only !== null ? only.note.id : null,
      fix: usable ? finding.fix : null,
      checked: usable && finding.checked,
      unwritable: finding.status === 'broken' && only !== null && finding.fix === null,
      outcome: null,
      seen: false
    };
  });
  const descriptions: DescriptionRow[] = review.descriptions.map((item) => ({
    kind: 'description',
    id: item.id,
    group: pathOf(item.folderId),
    item,
    checked: false,
    outcome: null,
    seen: false
  }));
  const folders: FolderRow[] = review.duplicates.map((duplicate) => ({
    kind: 'folder',
    id: `${duplicate.parentId ?? ''}\u0000${duplicate.key}`,
    group: '',
    duplicate
  }));
  const orphans = orphanRowsOf(review);
  const byGroup = <T extends { group: string }>(rows: T[]): T[] => rows.sort((a, b) => a.group.localeCompare(b.group));
  byGroup(links);
  byGroup(descriptions);
  byGroup(orphans);
  return {
    review,
    sections: [
      { id: 'links', rows: links, grouping: 'heading' },
      { id: 'descriptions', rows: descriptions, grouping: 'heading' },
      { id: 'folders', rows: folders, grouping: 'none' },
      { id: 'orphans', rows: orphans, grouping: 'folded' }
    ]
  };
}

export const sectionOf = (model: ResultsModel, id: SectionId): Section => model.sections.find((s) => s.id === id)!;
const linkRows = (model: ResultsModel): LinkRow[] => sectionOf(model, 'links').rows as LinkRow[];
const descriptionRows = (model: ResultsModel): DescriptionRow[] => sectionOf(model, 'descriptions').rows as DescriptionRow[];

/** Elegir un candidato de un enlace: planifica el arreglo y, si lo hay, marca la fila. */
export function chooseCandidate(model: ResultsModel, rowId: string, noteId: string | null): void {
  const row = linkRows(model).find((r) => r.id === rowId);
  if (!row || row.outcome !== null) return;
  const candidate = row.finding.candidates.find((c) => c.note.id === noteId);
  if (!candidate) {
    row.chosen = null;
    row.fix = null;
    row.checked = false;
    row.unwritable = false;
    return;
  }
  row.chosen = candidate.note.id;
  row.fix = planFix(model.review.index, candidate.note);
  row.unwritable = row.fix === null;
  row.checked = row.fix !== null;
}

/** Marcar o desmarcar una fila; una fila sin arreglo no se puede marcar. */
export function setChecked(model: ResultsModel, rowId: string, checked: boolean): void {
  for (const row of [...linkRows(model), ...descriptionRows(model)]) {
    if (row.id !== rowId || row.outcome !== null) continue;
    if (row.kind === 'link') row.checked = checked && row.fix !== null;
    else row.checked = checked && row.item.proposal !== null && row.item.writable;
  }
}

/** «Marcar todo lo seguro»: los arreglos que la revisión dejó marcados (y siguen teniendo arreglo). */
export function markSafe(model: ResultsModel): void {
  for (const row of linkRows(model)) {
    if (row.outcome === null && row.finding.checked && row.fix !== null && row.chosen === row.finding.candidates[0]?.note.id) row.checked = true;
  }
}

/** Anota el resultado de aplicar en las filas (y las deja sin casilla marcada). */
export function recordOutcomes(model: ResultsModel, outcomes: ReadonlyMap<string, Outcome>): void {
  for (const row of [...linkRows(model), ...descriptionRows(model)]) {
    const outcome = outcomes.get(row.id);
    if (!outcome) continue;
    row.outcome = outcome;
    row.checked = false;
  }
}

export function clearAll(model: ResultsModel): void {
  for (const row of linkRows(model)) row.checked = false;
  for (const row of descriptionRows(model)) row.checked = false;
}

export interface Counts {
  /** Enlaces rotos y ambiguos. */
  links: number;
  /** De ellos, con la casilla marcada ahora. */
  linksChecked: number;
  descriptions: number;
  duplicates: number;
  orphans: number;
  /** Cambios que aplicaría el botón (apariciones de enlace + descripciones). */
  changes: number;
  /** Notas distintas que tocaría. */
  notes: number;
  /** De los cambios marcados, los de filas que nunca se han pintado (marcadas por defecto sin verlas). */
  unseen: number;
}

export function countsOf(model: ResultsModel): Counts {
  // Lo ya hecho deja de contar; lo que falló sigue siendo un problema pendiente (sin casilla).
  const rowsLinks = linkRows(model).filter((r) => r.outcome?.state !== 'done');
  const rowsDescriptions = descriptionRows(model).filter((r) => r.outcome?.state !== 'done');
  const touched = new Set<string>();
  let changes = 0;
  let unseen = 0;
  let linksChecked = 0;
  for (const row of rowsLinks) {
    if (!row.checked) continue;
    linksChecked += 1;
    changes += row.finding.occurrences;
    if (!row.seen) unseen += row.finding.occurrences;
    touched.add(row.finding.sourceId);
  }
  for (const row of rowsDescriptions) {
    if (!row.checked) continue;
    changes += 1;
    if (!row.seen) unseen += 1;
    touched.add(row.item.id);
  }
  return {
    links: rowsLinks.length,
    linksChecked,
    descriptions: rowsDescriptions.length,
    duplicates: sectionOf(model, 'folders').rows.length,
    orphans: sectionOf(model, 'orphans').rows.length,
    changes,
    notes: touched.size,
    unseen
  };
}

export const isEmpty = (c: Counts): boolean => c.links + c.descriptions + c.duplicates + c.orphans === 0;

export function applyLabel(c: Counts): string {
  if (c.changes === 0) return 'Aplicar cambios';
  const unseen = c.unseen > 0 ? ` (${c.unseen} sin ver)` : '';
  return `Aplicar ${c.changes} ${c.changes === 1 ? 'cambio' : 'cambios'} en ${c.notes} ${c.notes === 1 ? 'nota' : 'notas'}${unseen}`;
}

export function headingOf(id: SectionId, c: Counts): string {
  switch (id) {
    case 'links':
      return `Enlaces rotos (${formatCount(c.links)}, ${formatCount(c.linksChecked)} con arreglo marcado)`;
    case 'descriptions':
      return `Sin descripción (${formatCount(c.descriptions)})`;
    case 'folders':
      return `Carpetas duplicadas (${formatCount(c.duplicates)})`;
    case 'orphans':
      return `Sin enlaces entrantes (${formatCount(c.orphans)})`;
  }
}
