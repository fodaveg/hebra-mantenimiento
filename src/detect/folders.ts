/**
 * Detector «Carpetas duplicadas». Puro: dos o más carpetas con el MISMO padre cuyo nombre es
 * igual tras NFC, recortar y minúsculas. Distinto padre o distinto nombre no cuentan.
 */
import type { PluginFolder } from 'hebra-plugin-api/v2';

export interface DuplicateFolder {
  id: string;
  /** Nombre exacto, sin normalizar. */
  name: string;
  /** Ruta completa desde la raíz, con `/`. */
  path: string;
  noteCount: number;
}

export interface DuplicateFolderGroup {
  parentId: string | null;
  /** Ruta del padre (vacía en la raíz). */
  parentPath: string;
  /** Nombre normalizado que comparten. */
  key: string;
  folders: DuplicateFolder[];
}

export function normalizeFolderName(name: string): string {
  return name.normalize('NFC').trim().toLowerCase();
}

export function detectDuplicateFolders(folders: readonly PluginFolder[]): DuplicateFolderGroup[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const pathOf = (folder: PluginFolder): string => {
    const parts: string[] = [];
    const seen = new Set<string>();
    for (let cur: PluginFolder | undefined = folder; cur && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
      seen.add(cur.id);
      parts.unshift(cur.name);
    }
    return parts.join('/');
  };
  const groups = new Map<string, PluginFolder[]>();
  for (const folder of folders) {
    const key = `${folder.parentId ?? ''}\u0000${normalizeFolderName(folder.name)}`;
    const list = groups.get(key);
    if (list) list.push(folder);
    else groups.set(key, [folder]);
  }
  const out: DuplicateFolderGroup[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const parent = list[0].parentId ? byId.get(list[0].parentId) : undefined;
    out.push({
      parentId: list[0].parentId,
      parentPath: parent ? pathOf(parent) : '',
      key: normalizeFolderName(list[0].name),
      folders: list.map((f) => ({ id: f.id, name: f.name, path: pathOf(f), noteCount: f.noteCount ?? 0 }))
    });
  }
  return out.sort((a, b) => a.parentPath.localeCompare(b.parentPath) || a.key.localeCompare(b.key));
}
