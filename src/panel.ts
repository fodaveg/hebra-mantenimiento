/**
 * La pestaña «Mantenimiento»: el botón «Revisar la biblioteca» lanza el recorrido (`./scan/`),
 * enseña el progreso con números («Leyendo notas: 1.200 de 4.050») y «Cancelar»; al acabar, de
 * momento, un recuento (las secciones de resultados son de P5).
 *
 * DOM llano sobre `el.ownerDocument` (la pestaña vive en un marco de superficie, donde
 * `document` no es el de `el`). Solo clases `hebra-mantenimiento-*`; los colores salen de las
 * variables CSS de Hebra (`src/hebra-styles.css`).
 */
import { formatCount } from './results/format';
import type { ReviewData } from './results/model';
import { mountResults, type MountedResults, type ResultsHost } from './results/view';
import { ScanCancelledError, type ScanProgress, type ScanResult } from './scan/types';

export const PANEL_TITLE = 'Mantenimiento';
export const PANEL_INTRO =
  'Revisa la biblioteca para buscar enlaces rotos, notas sin descripción, carpetas duplicadas y notas sin enlaces entrantes.';
export const PANEL_BUTTON = 'Revisar la biblioteca';
export const CANCEL_BUTTON = 'Cancelar';

/** Lo que la pestaña necesita para revisar: lo monta `main.ts` con la API. */
export type RunReview = (signal: AbortSignal, onProgress: (progress: ScanProgress) => void) => Promise<ReviewData>;

/** Los botones de Hebra que usa la pestaña, más el aviso de cambios en la biblioteca. */
export interface PanelHost extends ResultsHost {
  /** Hebra avisa de que cambiaron notas (`workspace.onNotesChange`). Devuelve el «dejar de oír». */
  onNotesChange(listener: () => void): () => void;
}

export const RETRY_BUTTON = 'Reintentar';
export const STALE_TEXT = 'La biblioteca ha cambiado desde la revisión';
export const STALE_BUTTON = 'Revisar de nuevo';
export const ERROR_TEXT = 'No se pudo leer la biblioteca.';

export { formatCount };

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
    case 'detecting':
      return 'Buscando problemas…';
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
export function mountPanel(el: HTMLElement, run: RunReview, host: PanelHost): () => void {
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

  const stale = doc.createElement('div');
  stale.className = 'hebra-mantenimiento-stale';
  stale.setAttribute('role', 'status');
  stale.hidden = true;
  const staleText = doc.createElement('span');
  staleText.textContent = STALE_TEXT;
  const staleButton = doc.createElement('button');
  staleButton.type = 'button';
  staleButton.className = 'hebra-mantenimiento-action';
  staleButton.textContent = STALE_BUTTON;
  stale.append(staleText, staleButton);

  const resultsBox = doc.createElement('div');
  resultsBox.className = 'hebra-mantenimiento-results-box';

  root.append(title, intro, status, actions, stale, resultsBox);
  el.replaceChildren(root);

  let controller: AbortController | null = null;
  let mounted: MountedResults | null = null;
  let alive = true;
  const show = (text: string): void => {
    status.hidden = false;
    status.textContent = text;
  };
  const clearResults = (): void => {
    mounted?.unmount();
    mounted = null;
    stale.hidden = true;
  };

  const start = (): void => {
    if (controller) return;
    const mine = new AbortController();
    controller = mine;
    clearResults();
    button.disabled = true;
    button.textContent = PANEL_BUTTON;
    cancel.hidden = false;
    show('Leyendo carpetas…');
    run(mine.signal, (progress) => {
      if (alive && !mine.signal.aborted) show(progressText(progress));
    })
      .then((review) => {
        if (!alive) return;
        show(summaryText(review.scan));
        mounted = mountResults(resultsBox, review, host);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        if (error instanceof ScanCancelledError) {
          show('Revisión cancelada.');
          return;
        }
        show(ERROR_TEXT);
        status.title = error instanceof Error ? error.message : String(error);
        button.textContent = RETRY_BUTTON;
      })
      .finally(() => {
        controller = null;
        if (!alive) return;
        button.disabled = false;
        cancel.hidden = true;
      });
  };
  button.addEventListener('click', start);
  staleButton.addEventListener('click', start);
  cancel.addEventListener('click', () => controller?.abort());

  // Si cambia la biblioteca con los resultados a la vista, ya no son de fiar.
  const offChanges = host.onNotesChange(() => {
    if (alive && mounted !== null && controller === null) stale.hidden = false;
  });

  return () => {
    alive = false;
    offChanges();
    controller?.abort();
    clearResults();
    el.replaceChildren();
  };
}
