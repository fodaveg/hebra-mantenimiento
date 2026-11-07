/**
 * Escribir y leer la propiedad `descripcion` sin riesgo (B1 de la revisión de P6).
 *
 * `markdown.frontmatter` aplana lo que no es texto: un mapa YAML (`descripcion:\n  es: Texto`)
 * llega como `[]`, igual que una lista vacía, y un número o un booleano llegan como tal. Por eso
 * «sin descripción» solo vale cuando la clave falta o está VACÍA de verdad, mirando también el
 * texto crudo del frontmatter (`frontmatterRange`); ante la duda no se propone nada. Y antes de
 * escribir se comprueba que el frontmatter nuevo, quitada `descripcion`, es el de antes y que el
 * cuerpo tras él no cambió.
 */
import type { PluginMarkdown } from 'hebra-plugin-api/v2';

export const DESCRIPTION_KEY = 'descripcion';
/** Claves que cuentan como descripción al leer. Se escribe siempre `descripcion`. */
export const DESCRIPTION_KEYS = ['descripcion', 'descripción', 'description'];

export type DescriptionState = 'present' | 'absent' | 'unknown';

type Reader = Pick<PluginMarkdown, 'frontmatter' | 'frontmatterRange'>;

/** ¿La clave abre en el texto crudo un bloque anidado (mapa o lista), o es un valor vacío? */
function rawShape(raw: string, key: string): 'block' | 'empty' | 'other' {
  const lines = raw.split(/\r?\n/);
  const pattern = new RegExp(`^['"]?${key}['"]?\\s*:(.*)$`, 'i');
  for (let i = 0; i < lines.length; i += 1) {
    const match = pattern.exec(lines[i]);
    if (!match) continue;
    const rest = match[1].replace(/\s+#.*$/, '').trim();
    if (rest === '') {
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j].trim() === '') continue;
        if (!/^(\s+\S|-\s|-$)/.test(lines[j]) || /^(---|\.\.\.)$/.test(lines[j])) return 'empty';
        // Un bloque anidado: vacío solo si TODO son elementos de lista vacíos (`- ""`).
        for (let k = j; k < lines.length && /^(\s+\S|-\s|-$)/.test(lines[k]); k += 1) {
          if (!/^\s*-\s*(""|''|)\s*$/.test(lines[k])) return 'block';
        }
        return 'empty';
      }
      return 'empty';
    }
    return ['[]', '""', "''", 'null', '~'].includes(rest) ? 'empty' : 'other';
  }
  return 'other';
}

/**
 * `absent`: no hay descripción (clave ausente o vacía) y se puede proponer una.
 * `present`: tiene texto. `unknown`: algo que no es texto (mapa, número, booleano…) o frontmatter
 * ilegible: no se toca ni se propone.
 */
export function descriptionState(markdown: Reader, body: string): DescriptionState {
  const fm = markdown.frontmatter(body);
  const range = markdown.frontmatterRange(body);
  if (fm === null) return range === null ? 'absent' : 'unknown';
  const raw = range ? body.slice(range.start, range.end) : '';
  let unknown = false;
  for (const key of Object.keys(fm)) {
    if (!DESCRIPTION_KEYS.includes(key.toLowerCase())) continue;
    const value = fm[key];
    if (typeof value === 'string') {
      if (value.trim() !== '') return 'present';
    } else if (value === null || value === undefined) {
      // vacía
    } else if (Array.isArray(value)) {
      if (value.some((item) => typeof item === 'string' && item.trim() !== '')) return 'present';
      const onlyStrings = value.every((item) => typeof item === 'string');
      if (!onlyStrings || (value.length === 0 && rawShape(raw, key) !== 'empty')) unknown = true;
    } else unknown = true;
  }
  return unknown ? 'unknown' : 'absent';
}

const without = (fm: Readonly<Record<string, unknown>> | null): string =>
  JSON.stringify(Object.entries(fm ?? {}).filter(([k]) => k !== DESCRIPTION_KEY).sort(([a], [b]) => a.localeCompare(b)));

const restOf = (markdown: Reader, text: string): string => {
  const range = markdown.frontmatterRange(text);
  return range ? text.slice(range.end) : text;
};

/**
 * El cuerpo con `descripcion: value` escrito, o `null` si no se puede sin riesgo: `setProperty`
 * lo dejó igual o lanzó, la propiedad no se relee EXACTA, cambió otra clave del frontmatter o
 * cambió algo del cuerpo tras el frontmatter.
 */
export function writeDescription(markdown: Pick<PluginMarkdown, 'frontmatter' | 'frontmatterRange' | 'setProperty'>, body: string, value: string): string | null {
  try {
    const next = markdown.setProperty(body, DESCRIPTION_KEY, value);
    if (next === body) return null;
    const after = markdown.frontmatter(next);
    if (after?.[DESCRIPTION_KEY] !== value) return null;
    if (without(markdown.frontmatter(body)) !== without(after)) return null;
    const before = restOf(markdown, body);
    const rest = restOf(markdown, next);
    const hadFrontmatter = markdown.frontmatterRange(body) !== null;
    if (rest !== before && !(!hadFrontmatter && rest.replace(/^\r?\n/, '') === before)) return null;
    return next;
  } catch {
    return null;
  }
}
