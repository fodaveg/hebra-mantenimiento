/**
 * Del cuerpo de una nota al derivado que se guarda (`NoteAnalysis`). Es lo único que llama a
 * `markdown.links` y `markdown.frontmatter`: el recorrido cuenta sus llamadas para probar que
 * ningún trozo entre dos esperas analiza más de 50 cuerpos.
 */
import type { LinkRef, NoteAnalysis, ScanMarkdown } from './types';

/** Sube si cambia cómo se deriva: la caché anterior deja de valer. */
export const CACHE_VERSION = 1;

const DESCRIPTION_KEYS = ['descripcion', 'descripción', 'description'];

export function analyzeBody(markdown: ScanMarkdown, sha256: string, body: string): NoteAnalysis {
  const frontmatter = markdown.frontmatter(body);
  const hasDescription =
    frontmatter !== null &&
    DESCRIPTION_KEYS.some((key) => {
      const value = frontmatter[key];
      return typeof value === 'string' && value.trim() !== '';
    });
  const links: LinkRef[] = markdown.links(body).map((link) => ({
    kind: link.kind,
    target: link.target,
    targetPath: link.targetPath,
    targetKind: link.targetKind,
    heading: link.heading,
    blockId: link.blockId
  }));
  return { sha256, v: CACHE_VERSION, hasDescription, links };
}
