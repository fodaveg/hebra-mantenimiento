/**
 * Verificación del cuerpo nuevo ANTES de escribirlo (B2 y B3 de la revisión de P6): se pide
 * `markdown.links` sobre el resultado y tiene que dar los mismos enlaces en el mismo número. Los
 * no tocados, idénticos (con sus posiciones desplazadas lo que mide el texto añadido o quitado
 * antes de ellos); cada reescrito, con el destino, el alias, el encabezado y el `!` esperados.
 * Así un alias que parte una celda de tabla, un título que abre un comentario `%%` o un destino
 * con paréntesis en una imagen se detectan sin tener que conocer las reglas de Hebra.
 */
import type { PluginMarkdownLink } from 'hebra-plugin-api/v2';
import { keyOf, keyString, parseTarget, visibleText, type LinkFix, type RewriteEdit } from '../detect/links';

export function verifyRewrite(
  before: readonly PluginMarkdownLink[],
  after: readonly PluginMarkdownLink[],
  fixes: readonly LinkFix[],
  edits: readonly RewriteEdit[],
  /** Cuánto se desplazó TODO lo que sigue al frontmatter (la descripción añadida o cambiada). */
  baseShift: number
): boolean {
  if (before.length !== after.length) return false;
  const byKey = new Map(fixes.map((fix) => [keyString(fix.key), fix]));
  const shift = (position: number): number =>
    baseShift + edits.filter((e) => e.at < position).reduce((sum, e) => sum + e.text.length - e.remove, 0);
  for (let i = 0; i < before.length; i += 1) {
    const b = before[i];
    const a = after[i];
    if (a.kind !== b.kind || a.heading !== b.heading || a.blockId !== b.blockId) return false;
    if (a.from !== b.from + shift(b.from)) return false;
    const fix = b.target === null ? undefined : byKey.get(keyString(keyOf({ ...b, target: b.target })));
    if (!fix) {
      if (
        a.rawTarget !== b.rawTarget ||
        a.target !== b.target ||
        a.targetPath !== b.targetPath ||
        a.targetKind !== b.targetKind ||
        a.alias !== b.alias ||
        a.to !== b.to + shift(b.to)
      ) {
        return false;
      }
      continue;
    }
    const expected = parseTarget(fix.newTarget);
    const alias = b.alias !== null ? b.alias : fix.addAlias && b.kind !== 'image' ? visibleText(b.rawTarget) : null;
    if (
      a.rawTarget !== fix.newTarget ||
      a.target !== expected.target ||
      a.targetPath !== expected.targetPath ||
      a.targetKind !== expected.targetKind ||
      a.alias !== alias
    ) {
      return false;
    }
  }
  return true;
}
