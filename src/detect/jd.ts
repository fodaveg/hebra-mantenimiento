/**
 * Prefijo Johnny.Decimal de un nombre, con el mismo patrón que JDex Manager
 * (`~/code/jdex-manager/src/jd/parse.ts`, `extractJdPrefix`): `10-19`, `11`, `11.01`, `11.01+`,
 * con sistema `D01.` delante opcional, seguido de un separador o del final.
 *
 * Solo hace falta saber SI hay prefijo, cuál es (para comparar) y el resto del título. Aquí el
 * sistema se admite en mayúsculas o minúsculas porque el destino de un enlace llega en
 * minúsculas (título canónico).
 */
const PREFIX = /^((?:[A-Za-z]\d{2}\.)?(?:\d0-\d9|\d{2}\.\d{2}\+?|\d{2}))(?:[\s_-]+|$)/;
const AREA = /^(?:[A-Za-z]\d{2}\.)?(\d)0-(\d)9$/;

export interface JdPrefix {
  /** El número tal como está escrito, en minúsculas (`11.01`, `d01.11.01+`). */
  number: string;
  /** El texto que sigue al prefijo y su separador. */
  title: string;
}

export function jdPrefixOf(text: string): JdPrefix | null {
  const base = text.replace(/\.md$/i, '').trim();
  const match = PREFIX.exec(base);
  if (!match) return null;
  const area = AREA.exec(match[1]);
  // `20-39` no es un área (la cifra inicial debe repetirse): como en JDex Manager, no cuenta.
  if (area && area[1] !== area[2]) return null;
  return { number: match[1].toLowerCase(), title: base.slice(match[0].length).trim() };
}
