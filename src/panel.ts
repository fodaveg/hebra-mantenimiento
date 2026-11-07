/**
 * La pestaña «Mantenimiento». En P1 solo enseña el estado vacío: título, qué busca y un botón
 * «Revisar la biblioteca» todavía deshabilitado (la revisión llega en las piezas siguientes).
 *
 * DOM llano sobre `el.ownerDocument` (la pestaña vive en un marco de superficie, donde
 * `document` no es el de `el`). Solo clases `hebra-mantenimiento-*`; los colores salen de las
 * variables CSS de Hebra (`src/hebra-styles.css`).
 */

export const PANEL_TITLE = 'Mantenimiento';
export const PANEL_INTRO =
  'Revisa la biblioteca para buscar enlaces rotos, notas sin descripción, carpetas duplicadas y notas sin enlaces entrantes.';
export const PANEL_BUTTON = 'Revisar la biblioteca';

/** Pinta el estado vacío dentro de `el`. Devuelve la limpieza que vacía `el`. */
export function mountPanel(el: HTMLElement): () => void {
  const doc = el.ownerDocument;
  const root = doc.createElement('section');
  root.className = 'hebra-mantenimiento';

  const title = doc.createElement('h2');
  title.className = 'hebra-mantenimiento-title';
  title.textContent = PANEL_TITLE;

  const intro = doc.createElement('p');
  intro.className = 'hebra-mantenimiento-intro';
  intro.textContent = PANEL_INTRO;

  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'hebra-mantenimiento-run';
  button.textContent = PANEL_BUTTON;
  button.disabled = true;

  root.append(title, intro, button);
  el.replaceChildren(root);
  return () => el.replaceChildren();
}
