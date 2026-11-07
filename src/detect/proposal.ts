/**
 * Propuesta de `descripcion` para una nota: su primer párrafo de prosa, limpio y a ≤200
 * caracteres. Puro. Misma limpieza que `firstSentence` de jdex-manager
 * (`src/jd/description.ts`), pero con el párrafo entero en vez de la primera frase.
 */

export const MAX_DESCRIPTION = 200;

/**
 * El cuerpo sin frontmatter. Con el `range` de `markdown.frontmatterRange` (la fuente de verdad
 * de Hebra: CRLF, BOM, cierre `...`) se corta ahí; sin él, una aproximación para los tests.
 */
export function stripFrontmatter(content: string, range?: { start: number; end: number } | null): string {
  if (range) return content.slice(range.end);
  const text = content.replace(/^\uFEFF/, '');
  const match = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  return match ? text.slice(match[0].length) : text;
}

/**
 * Primer párrafo de prosa: sin encabezados, listas, citas, tablas, código (con ``` o ~~~ o
 * sangrado), fórmulas `$$`, comentarios `%%…%%` ni `<!-- -->`, e incrustaciones. `range` es el del
 * frontmatter (`markdown.frontmatterRange`).
 */
export function proposeDescription(content: string, range?: { start: number; end: number } | null): string | null {
  const lines = stripFrontmatter(content, range).split(/\r?\n/);
  let fence: string | null = null;
  let math = false;
  let comment = false;
  let paragraph: string[] = [];
  let previousBlank = true;
  const flush = (): string | null => {
    const text = clean(paragraph.join(' '));
    paragraph = [];
    return text === '' ? null : text;
  };
  for (const raw of lines) {
    const line = raw.trim();
    let boundary = false;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
    if (fence !== null) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      boundary = true;
    } else if (marker) {
      fence = marker;
      boundary = true;
    } else if (math) {
      if (line.includes('$$')) math = false;
      boundary = true;
    } else if (line.startsWith('$$')) {
      math = !line.slice(2).includes('$$');
      boundary = true;
    } else if (comment || line.startsWith('%%')) {
      const marks = (line.match(/%%/g) ?? []).length;
      if (marks % 2 === 1) comment = !comment;
      boundary = true;
    } else if (paragraph.length === 0 && previousBlank && /^( {4}|\t)/.test(raw)) {
      boundary = true;
    } else if (line === '' || /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||<!--|!\[\[|\[\^[^\]]+\]:)/.test(line)) {
      boundary = true;
    }
    previousBlank = line === '';
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
    .replace(/!\[\[[^\]]*\]\]/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/%%.*?%%/g, '')
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
