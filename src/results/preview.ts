/**
 * La vista previa de un enlace: la línea de la nota donde está, antes y después del arreglo.
 * Pura: recibe el cuerpo y los enlaces de `markdown.links` de ESE cuerpo.
 */
import type { PluginMarkdownLink } from 'hebra-plugin-api/v2';
import { keyOf, keyString, rewriteLinks, type LinkKey, type PlannedFix } from '../detect/links';

export interface LinePreview {
  before: string;
  after: string;
}

const MAX_LINE = 240;

const clip = (line: string): string => {
  const text = line.trim();
  return text.length > MAX_LINE ? `${text.slice(0, MAX_LINE - 1)}…` : text;
};

const lineAt = (body: string, index: number): { text: string; number: number } => {
  const start = body.lastIndexOf('\n', index - 1) + 1;
  const end = body.indexOf('\n', index);
  return { text: body.slice(start, end < 0 ? body.length : end), number: body.slice(0, start).split('\n').length - 1 };
};

/** `null` si el enlace ya no está en el cuerpo. Sin `fix`, `after` es igual a `before`. */
export function linePreview(
  body: string,
  links: readonly PluginMarkdownLink[],
  key: LinkKey,
  fix: PlannedFix | null
): LinePreview | null {
  const wanted = keyString(key);
  const link = links.find((l) => l.target !== null && keyString(keyOf({ ...l, target: l.target })) === wanted);
  if (!link) return null;
  const line = lineAt(body, link.from);
  const before = clip(line.text);
  if (!fix) return { before, after: before };
  const rewritten = rewriteLinks(body, links, [{ key, newTarget: fix.newTarget, addAlias: fix.addAlias }]).body;
  const after = rewritten.split('\n')[line.number] ?? '';
  return { before, after: clip(after) };
}
