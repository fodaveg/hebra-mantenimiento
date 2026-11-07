/**
 * Del cuerpo de una nota al derivado que se guarda (`NoteAnalysis`). Es lo único que llama a
 * `markdown.links` y `markdown.frontmatter`: el recorrido cuenta sus llamadas para probar que
 * ningún trozo entre dos esperas analiza más de 50 cuerpos.
 */
import { proposeDescription } from '../detect/proposal';
import { descriptionState, writeDescription } from '../detect/write';
import type { LinkRef, NoteAnalysis, ScanMarkdown } from './types';

/** Sube si cambia cómo se deriva: la caché anterior deja de valer. */
export const CACHE_VERSION = 3;

export function analyzeBody(markdown: ScanMarkdown, sha256: string, body: string): NoteAnalysis {
  const frontmatter = markdown.frontmatter(body);
  // Solo «sin descripción» si la clave falta o está vacía de verdad; con duda (mapa, número…) no.
  const state = descriptionState(markdown, body);
  const hasDescription = state !== 'absent';
  const hasJd = frontmatter !== null && 'jd' in frontmatter;
  const links: LinkRef[] = markdown.links(body).map((link) => ({
    kind: link.kind,
    target: link.target,
    targetPath: link.targetPath,
    targetKind: link.targetKind,
    heading: link.heading,
    blockId: link.blockId
  }));
  // La propuesta se calcula aquí, con el cuerpo ya en memoria, para pintar resultados sin releerlo.
  // Sin descripción y sin `jd` es el único caso en que se usa: en los demás no se guarda.
  const proposedDescription = hasDescription || hasJd ? null : proposeDescription(body, markdown.frontmatterRange(body));
  // Ensayo en seco de la escritura: un frontmatter que no se puede parchear no lleva casilla (M7).
  const canWriteDescription =
    proposedDescription !== null && 'setProperty' in markdown && writeDescription(markdown as never, body, proposedDescription) !== null;
  return { sha256, v: CACHE_VERSION, hasDescription, hasJd, proposedDescription, canWriteDescription, links };
}
