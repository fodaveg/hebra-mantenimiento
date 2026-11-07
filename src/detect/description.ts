/**
 * Detector «Sin descripción». Puro: lee el resultado del recorrido, nunca el almacén. La propuesta
 * sale del derivado de la caché, así que pintar resultados no relee cuerpos.
 */
import type { ScanResult } from '../scan/types';

export interface MissingDescription {
  id: string;
  title: string;
  folderId: string;
  /** `null` = «Sin propuesta» (no hay párrafo de prosa): se lista sin casilla. */
  proposal: string | null;
  /** Hay propuesta pero el frontmatter no se puede parchear sin riesgo: sin casilla. */
  writable: boolean;
}

/** Excluye protegidas, copias de conflicto, archivadas y notas con `jd` en el frontmatter. */
export function detectMissingDescription(scan: Pick<ScanResult, 'notes'>): MissingDescription[] {
  const out: MissingDescription[] = [];
  for (const note of scan.notes) {
    const analysis = note.analysis;
    if (note.locked || note.conflictOf !== null || note.archivedAt !== null || analysis === null) continue;
    if (analysis.hasDescription || analysis.hasJd) continue;
    out.push({ id: note.id, title: note.title, folderId: note.folderId, proposal: analysis.proposedDescription, writable: analysis.canWriteDescription });
  }
  return out;
}
