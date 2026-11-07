/**
 * Propuesta de `descripcion` para una nota: su primer párrafo de prosa, limpio y a ≤200
 * caracteres. Puro. Misma limpieza que `firstSentence` de jdex-manager
 * (`src/jd/description.ts`), pero con el párrafo entero en vez de la primera frase.
 */

export const MAX_DESCRIPTION = 200;

/** El cuerpo sin frontmatter. */
export function stripFrontmatter(content: string): string {
  if (!content.startsWith('---\n')) return content;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return content;
  return content.slice(end + 4).replace(/^\r?\n/, '');
}

/** Primer párrafo de prosa (sin encabezados, listas, citas, tablas, código, comentarios ni incrustaciones). */
export function proposeDescription(content: string): string | null {
  const lines = stripFrontmatter(content).split('\n');
  let inFence = false;
  let paragraph: string[] = [];
  const flush = (): string | null => {
    const text = clean(paragraph.join(' '));
    paragraph = [];
    return text === '' ? null : text;
  };
  for (const raw of lines) {
    const line = raw.trim();
    let boundary = false;
    if (line.startsWith('```')) {
      inFence = !inFence;
      boundary = true;
    } else if (inFence) {
      continue;
    } else if (line === '' || /^(#{1,6}\s|[-*+]\s|\d+\.\s|>|\||<!--|!\[\[)/.test(line)) {
      boundary = true;
    }
    if (!boundary) {
      paragraph.push(line);
      continue;
    }
    const done = flush();
    if (done) return cut(done);
  }
  const last = flush();
  return last ? cut(last) : null;
}

function clean(text: string): string {
  return text
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** ≤200: tal cual. Si no, en el último final de frase antes de 200; si no hay, en el último espacio, con "...". */
function cut(text: string): string {
  if (text.length <= MAX_DESCRIPTION) return text;
  const head = text.slice(0, MAX_DESCRIPTION);
  let sentenceEnd = -1;
  for (let i = 0; i < head.length; i += 1) {
    if (/[.!?]/.test(head[i]) && (i + 1 === text.length || /\s/.test(text[i + 1]))) sentenceEnd = i;
  }
  if (sentenceEnd >= 0) return head.slice(0, sentenceEnd + 1);
  const room = text.slice(0, MAX_DESCRIPTION - 3);
  const space = room.lastIndexOf(' ');
  return `${(space > 0 ? room.slice(0, space) : room).trimEnd()}...`;
}
