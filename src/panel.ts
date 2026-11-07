/**
 * La pestaña «Mantenimiento»: el botón «Revisar la biblioteca» lanza el recorrido (`./scan/`),
 * enseña el progreso con números («Leyendo notas: 1.200 de 4.050») y «Cancelar»; al acabar, de
 * momento, un recuento (las secciones de resultados son de P5).
 *
 * DOM llano sobre `el.ownerDocument` (la pestaña vive en un marco de superficie, donde
 * `document` no es el de `el`). Solo clases `hebra-mantenimiento-*`; los colores salen de las
 * variables CSS de Hebra (`src/hebra-styles.css`).
 */
import { ScanCancelledError, type ScanProgress, type ScanResult } from './scan/types';

export const PANEL_TITLE = 'Mantenimiento';
export const PANEL_INTRO =
  'Revisa la biblioteca para buscar enlaces rotos, notas sin descripción, carpetas duplicadas y notas sin enlaces entrantes.';
export const PANEL_BUTTON = 'Revisar la biblioteca';
export const CANCEL_BUTTON = 'Cancelar';

/** Lo que la pestaña necesita para revisar: lo monta `main.ts` con la API. */
export type RunScan = (signal: AbortSignal, onProgress: (progress: ScanProgress) => void) => Promise<ScanResult>;

/** `4050` -> `4.050` (es-ES agrupa desde cinco cifras en algunos motores: aquí siempre). */
export function formatCount(value: number): string {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export function progressText({ phase, done, total }: ScanProgress): string {
  switch (phase) {
    case 'folders':
      return 'Leyendo carpetas…';
    case 'listing':
      return `Buscando notas: ${formatCount(done)}`;
    case 'summaries':
      return `Preparando notas: ${formatCount(done)} de ${formatCount(total)}`;
    case 'reading':
      return `Leyendo notas: ${formatCount(done)} de ${formatCount(total)}`;
  }
}

export function summaryText({ stats }: ScanResult): string {
  const parts = [`${formatCount(stats.notes)} notas revisadas`];
  if (stats.archived > 0) parts.push(`${formatCount(stats.archived)} archivadas`);
  if (stats.locked > 0) parts.push(`${formatCount(stats.locked)} protegidas sin leer`);
  parts.push(`${formatCount(stats.reads)} leídas, ${formatCount(stats.cacheHits)} ya conocidas`);
  return `${parts[0]} (${parts.slice(1).join(', ')}).`;
}

/** Pinta la pestaña dentro de `el`. Devuelve la limpieza: cancela lo que esté en marcha. */
export function mountPanel(el: HTMLElement, run: RunScan): () => void {
  const doc = el.ownerDocument;
  const root = doc.createElement('section');
  root.className = 'hebra-mantenimiento';

  const title = doc.createElement('h2');
  title.className = 'hebra-mantenimiento-title';
  title.textContent = PANEL_TITLE;

  const intro = doc.createElement('p');
  intro.className = 'hebra-mantenimiento-intro';
  intro.textContent = PANEL_INTRO;

  const status = doc.createElement('p');
  status.className = 'hebra-mantenimiento-status';
  status.setAttribute('role', 'status');
  status.hidden = true;

  const actions = doc.createElement('div');
  actions.className = 'hebra-mantenimiento-actions';
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'hebra-mantenimiento-run';
  button.textContent = PANEL_BUTTON;
  const cancel = doc.createElement('button');
  cancel.type = 'button';
  cancel.className = 'hebra-mantenimiento-cancel';
  cancel.textContent = CANCEL_BUTTON;
  cancel.hidden = true;
  actions.append(button, cancel);

  root.append(title, intro, status, actions);
  el.replaceChildren(root);

  let controller: AbortController | null = null;
  let alive = true;
  const show = (text: string): void => {
    status.hidden = false;
    status.textContent = text;
  };

  button.addEventListener('click', () => {
    if (controller) return;
    const mine = new AbortController();
    controller = mine;
    button.disabled = true;
    cancel.hidden = false;
    show('Leyendo carpetas…');
    run(mine.signal, (progress) => {
      if (alive && !mine.signal.aborted) show(progressText(progress));
    })
      .then((result) => alive && show(summaryText(result)))
      .catch((error: unknown) => {
        if (!alive) return;
        show(
          error instanceof ScanCancelledError
            ? 'Revisión cancelada.'
            : `No se pudo revisar la biblioteca: ${error instanceof Error ? error.message : String(error)}`
        );
      })
      .finally(() => {
        controller = null;
        if (!alive) return;
        button.disabled = false;
        cancel.hidden = true;
      });
  });
  cancel.addEventListener('click', () => controller?.abort());

  return () => {
    alive = false;
    controller?.abort();
    el.replaceChildren();
  };
}
