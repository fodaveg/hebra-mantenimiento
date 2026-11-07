/**
 * La pestaña «Mantenimiento», con el aspecto de Ajustes de Hebra (0.1.1): cabecera con el
 * título, una línea de qué hace y el botón principal «Revisar la biblioteca»; antes de la
 * primera revisión, una tarjeta con lo que revisa; durante el recorrido, el progreso con
 * números («Leyendo notas: 1.200 de 4.050»), una barra y «Cancelar»; al acabar, el recuento y
 * los resultados (`./results/view.ts`).
 *
 * DOM llano sobre `el.ownerDocument` (la pestaña vive en un marco de superficie, donde
 * `document` no es el de `el`). Solo clases `hebra-mantenimiento-*`; los colores salen de las
 * variables CSS de Hebra, con valores de reserva, y la letra es la de Hebra
 * (`src/hebra-styles.css`): la pestaña se ve bien aunque Hebra no ponga su hoja base.
 */
import { formatCount } from './results/format';
import { countsOf, isEmpty, type ReviewData } from './results/model';
import { mountResults, type MountedResults, type ResultsHost } from './results/view';
import { ScanCancelledError, type ScanProgress, type ScanResult } from './scan/types';

export const PANEL_TITLE = 'Mantenimiento';
export const PANEL_INTRO =
  'Busca enlaces rotos, notas sin descripción, carpetas duplicadas y notas a las que nada enlaza, y propone arreglos que ves antes de aplicarlos.';
export const PANEL_BUTTON = 'Revisar la biblioteca';
export const CANCEL_BUTTON = 'Cancelar';

/** Lo que revisa, para la tarjeta de antes de la primera revisión: título y una línea. */
export const CHECKS: readonly (readonly [string, string])[] = [
  ['Enlaces rotos', 'Enlaces a notas que no existen. Si encuentra la nota a la que apuntaban, propone el arreglo.'],
  ['Notas sin descripción', 'Propone una descripción sacada del primer párrafo de la nota.'],
  ['Carpetas duplicadas', 'Carpetas hermanas con el mismo nombre. Solo avisa.'],
  ['Notas sin enlaces entrantes', 'Notas a las que no enlaza ninguna otra. Solo avisa.']
];
export const CHECKS_TITLE = 'Qué revisa';
export const CHECKS_NOTE =
  'No cambia nada hasta que marcas un arreglo y pulsas Aplicar. Nunca borra, mueve ni renombra notas o carpetas.';

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

/** Fracción hecha de un paso con total conocido (0..1), o `null` si el paso no tiene total. */
export function progressFraction({ done, total }: ScanProgress): number | null {
  if (!(total > 0)) return null;
  return Math.min(1, Math.max(0, done / total));
}

/** Pinta la pestaña dentro de `el`. Devuelve la limpieza: cancela lo que esté en marcha. */
export function mountPanel(el: HTMLElement, run: RunReview, host: PanelHost): () => void {
  const doc = el.ownerDocument;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (className) node.className = `hebra-mantenimiento-${className}`;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const root = doc.createElement('section');
  root.className = 'hebra-mantenimiento';
  root.setAttribute('aria-labelledby', 'hebra-mantenimiento-title');

  const head = make('header', 'head');
  const title = make('h1', 'title', PANEL_TITLE);
  title.id = 'hebra-mantenimiento-title';
  const intro = make('p', 'intro', PANEL_INTRO);
  const actions = make('div', 'actions');
  const button = make('button', 'run', PANEL_BUTTON);
  button.type = 'button';
  const cancel = make('button', 'cancel', CANCEL_BUTTON);
  cancel.type = 'button';
  cancel.hidden = true;
  actions.append(button, cancel);
  head.append(title, intro, actions);

  // Progreso: el texto (que lee el lector de pantalla) y una barra con el paso en curso.
  const progress = make('div', 'progress');
  const status = make('p', 'status');
  status.setAttribute('role', 'status');
  status.hidden = true;
  const bar = make('div', 'bar');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', 'Progreso de la revisión');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.hidden = true;
  const fill = make('div', 'bar-fill');
  bar.append(fill);
  progress.append(status, bar);

  const stale = make('div', 'stale');
  stale.setAttribute('role', 'status');
  stale.hidden = true;
  const staleButton = make('button', 'action', STALE_BUTTON);
  staleButton.type = 'button';
  stale.append(make('span', 'stale-text', STALE_TEXT), staleButton);

  // Antes de la primera revisión: qué revisa y la promesa de no tocar nada sin permiso.
  const checks = make('section', 'checks');
  checks.setAttribute('aria-labelledby', 'hebra-mantenimiento-checks-title');
  const checksTitle = make('h2', 'checks-title', CHECKS_TITLE);
  checksTitle.id = 'hebra-mantenimiento-checks-title';
  const list = make('ul', 'checks-list');
  for (const [name, text] of CHECKS) {
    const item = make('li', 'check-item');
    item.append(make('strong', 'check-name', name), make('span', 'check-text', text));
    list.append(item);
  }
  checks.append(checksTitle, list, make('p', 'checks-note', CHECKS_NOTE));

  const resultsBox = make('div', 'results-box');

  root.append(head, progress, stale, checks, resultsBox);
  el.replaceChildren(root);

  let controller: AbortController | null = null;
  let mounted: MountedResults | null = null;
  /** La última revisión enseñó hallazgos: solo entonces tiene sentido avisar de que caducaron. */
  let withFindings = false;
  let alive = true;
  const show = (text: string): void => {
    status.hidden = false;
    status.textContent = text;
  };
  const showBar = (fraction: number | null): void => {
    bar.hidden = false;
    if (fraction === null) {
      bar.removeAttribute('aria-valuenow');
      bar.dataset.indeterminate = 'true';
      fill.style.width = '';
      return;
    }
    const percent = Math.round(fraction * 100);
    delete bar.dataset.indeterminate;
    bar.setAttribute('aria-valuenow', String(percent));
    fill.style.width = `${percent}%`;
  };
  const clearResults = (): void => {
    mounted?.unmount();
    mounted = null;
    withFindings = false;
    stale.hidden = true;
  };

  const start = (): void => {
    if (controller) return;
    const mine = new AbortController();
    controller = mine;
    clearResults();
    checks.hidden = true;
    button.disabled = true;
    button.textContent = PANEL_BUTTON;
    status.removeAttribute('title');
    cancel.hidden = false;
    root.setAttribute('aria-busy', 'true');
    show('Leyendo carpetas…');
    showBar(null);
    run(mine.signal, (step) => {
      if (!alive || mine.signal.aborted) return;
      show(progressText(step));
      showBar(progressFraction(step));
    })
      .then((review) => {
        if (!alive) return;
        show(summaryText(review.scan));
        mounted = mountResults(resultsBox, review, host);
        withFindings = !isEmpty(countsOf(mounted.model));
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
        root.removeAttribute('aria-busy');
        bar.hidden = true;
        button.disabled = false;
        cancel.hidden = true;
        // Cancelada o fallida sin resultados que enseñar: vuelve la tarjeta de qué revisa.
        if (mounted === null) checks.hidden = false;
      });
  };
  button.addEventListener('click', start);
  staleButton.addEventListener('click', start);
  cancel.addEventListener('click', () => controller?.abort());

  // Si cambia la biblioteca con hallazgos a la vista, ya no son de fiar.
  const offChanges = host.onNotesChange(() => {
    if (alive && mounted !== null && withFindings && controller === null) stale.hidden = false;
  });

  return () => {
    alive = false;
    offChanges();
    controller?.abort();
    clearResults();
    el.replaceChildren();
  };
}
