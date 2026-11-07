/**
 * Detector «Sin enlaces entrantes». Puro. Una nota viva (no archivada, no copia de conflicto)
 * es huérfana si ni su título canónico ni su id son destino de un enlace de OTRA nota. Se compara
 * por título canónico o id, sin mirar la ruta ni si el enlace es ambiguo. Las archivadas cuentan
 * como fuente; las protegidas no (no se leen); la propia nota tampoco.
 */
import type { ScanResult } from '../scan/types';
import { canonicalTitle } from '../scan/renames';

export interface OrphanNote {
  id: string;
  title: string;
}

export interface OrphanFolderGroup {
  folderId: string;
  notes: OrphanNote[];
}

export function detectOrphans(scan: Pick<ScanResult, 'notes'>): OrphanFolderGroup[] {
  // Destino -> ids de las notas que lo enlazan. Así «la propia nota no cuenta» es exacto.
  const titleSources = new Map<string, Set<string>>();
  const idSources = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, source: string): void => {
    const set = map.get(key);
    if (set) set.add(source);
    else map.set(key, new Set([source]));
  };
  for (const note of scan.notes) {
    if (note.locked || note.analysis === null) continue;
    for (const link of note.analysis.links) {
      if (link.target === null) continue;
      if (link.targetKind === 'note-title' || link.targetKind === 'note-path') add(titleSources, link.target, note.id);
      else if (link.targetKind === 'note-id') add(idSources, link.target, note.id);
    }
  }
  const hasOther = (set: Set<string> | undefined, self: string): boolean => {
    if (!set) return false;
    for (const source of set) if (source !== self) return true;
    return false;
  };
  const groups = new Map<string, OrphanNote[]>();
  for (const note of scan.notes) {
    if (note.archivedAt !== null || note.conflictOf !== null) continue;
    if (hasOther(titleSources.get(canonicalTitle(note.title)), note.id) || hasOther(idSources.get(note.id), note.id)) continue;
    const list = groups.get(note.folderId);
    const entry = { id: note.id, title: note.title };
    if (list) list.push(entry);
    else groups.set(note.folderId, [entry]);
  }
  return [...groups].map(([folderId, notes]) => ({ folderId, notes })).sort((a, b) => a.folderId.localeCompare(b.folderId));
}
