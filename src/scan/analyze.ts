/**
 * Del cuerpo de una nota al derivado que se guarda (`NoteAnalysis`). Es lo único que llama a
 * `markdown.links` y `markdown.frontmatter`: el recorrido cuenta sus llamadas para probar que
 * ningún trozo entre dos esperas analiza más de 50 cuerpos.
 */
import { proposeDescription } from '../detect/proposal';
import type { LinkRef, NoteAnalysis, ScanMarkdown } from './types';

/** Sube si cambia cómo se deriva: la caché anterior deja de valer. */
export const CACHE_VERSION = 2;

const DESCRIPTION_KEYS = ['descripcion', 'descripción', 'description'];

export function analyzeBody(markdown: ScanMarkdown, sha256: string, body: string): NoteAnalysis {
  const frontmatter = markdown.frontmatter(body);
  const hasDescription =
    frontmatter !== null &&
    DESCRIPTION_KEYS.some((key) => {
      const value = frontmatter[key];
      if (Array.isArray(value)) return value.some((item) => typeof item === 'string' && item.trim() !== '');
      return typeof value === 'string' && value.trim() !== '';
    });
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
  const proposedDescription = hasDescription || hasJd ? null : proposeDescription(body);
  return { sha256, v: CACHE_VERSION, hasDescription, hasJd, proposedDescription, links };
}
