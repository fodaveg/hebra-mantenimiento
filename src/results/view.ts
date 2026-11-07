/**
 * Pinta los resultados (P5): cuatro secciones con encabezado y recuento, filas con casilla
 * nativa, vista previa antes/después y los controles de elegir candidato. DOM llano sobre
 * `el.ownerDocument`; solo clases `hebra-mantenimiento-*` (variables CSS de Hebra).
 *
 * Presupuesto de pintado: como mucho `MAX_PAINTED_ROWS` (200) filas en el documento a la vez.
 * Solo UNA sección está desplegada (las demás no pintan filas) y su ventana crece de 100 en 100
 * hasta 200; a partir de ahí «Ver 100 más» DESLIZA la ventana en vez de ampliarla.
 */
import type { LinkKey, PlannedFix } from '../detect/links';
import { formatCount } from './format';
import type { LinePreview } from './preview';
import {
  applyLabel,
  buildModel,
  chooseCandidate,
  clearAll,
  countsOf,
  headingOf,
  isEmpty,
  markSafe,
  setChecked,
  type DescriptionRow,
  type FolderRow,
  type LinkRow,
  type OrphanRow,
  type ResultsModel,
  type ReviewData,
  type Row,
  type Section,
  type SectionId
} from './model';

export const PAGE_ROWS = 100;
export const MAX_PAINTED_ROWS = 200;

/** Lo que la pestaña necesita de Hebra para sus botones. */
export interface ResultsHost {
  openNote(id: string): void;
  openSearch(query: string): void;
  selectFolder(id: string): void;
  /** La línea del enlace en la nota, antes y después del arreglo (`null`: sin arreglo todavía). */
  linkPreview(noteId: string, key: LinkKey, fix: PlannedFix | null): Promise<LinePreview | null>;
}

export const EMPTY_TEXT = 'No hay nada que arreglar';
export const SAFE_BUTTON = 'Marcar todo lo seguro';
export const CLEAR_BUTTON = 'Desmarcar todo';
export const MORE_BUTTON = `Ver ${PAGE_ROWS} más`;
export const PREVIOUS_BUTTON = `Ver ${PAGE_ROWS} anteriores`;

const SECTION_ORDER: SectionId[] = ['links', 'descriptions', 'folders', 'orphans'];

export interface MountedResults {
  model: ResultsModel;
  /** Cuántas filas hay pintadas ahora mismo. */
  painted(): number;
  unmount(): void;
}

export function mountResults(
  el: HTMLElement,
  review: ReviewData,
  host: ResultsHost,
  options: { maxRows?: number } = {}
): MountedResults {
  const doc = el.ownerDocument;
  const model = buildModel(review);
  const pageRows = PAGE_ROWS;
  const maxRows = options.maxRows ?? MAX_PAINTED_ROWS;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (className) node.className = `hebra-mantenimiento-${className}`;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text: string, onClick: () => void, className = 'action'): HTMLButtonElement => {
    const b = make('button', className, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };

  let alive = true;
  let open: SectionId = SECTION_ORDER.find((id) => model.sections.find((s) => s.id === id)!.rows.length > 0) ?? 'links';
  const windows = new Map<SectionId, { start: number; size: number }>(SECTION_ORDER.map((id) => [id, { start: 0, size: pageRows }]));
  /** Quien repinta lo que depende de la casilla / elección de cada fila pintada. */
  let refreshers = new Map<string, () => void>();
  let paintedRows = 0;

  const root = make('div', 'results');
  const empty = make('p', 'empty', EMPTY_TEXT);
  const toolbar = make('div', 'toolbar');
  toolbar.append(button(SAFE_BUTTON, () => { markSafe(model); refreshAll(); }), button(CLEAR_BUTTON, () => { clearAll(model); refreshAll(); }));
  const sectionsBox = make('div', 'sections');
  const applyButton = make('button', 'apply');
  applyButton.type = 'button';
  applyButton.disabled = true; // Aplicar es P6.
  const footer = make('div', 'footer');
  footer.append(applyButton);

  const headings = new Map<SectionId, HTMLButtonElement>();
  const bodies = new Map<SectionId, HTMLElement>();

  function refreshAll(): void {
    for (const refresh of refreshers.values()) refresh();
    refreshCounts();
  }

  function refreshCounts(): void {
    const counts = countsOf(model);
    for (const [id, heading] of headings) heading.textContent = headingOf(id, counts);
    applyButton.textContent = applyLabel(counts);
  }

  function renderBody(section: Section): void {
    const body = bodies.get(section.id)!;
    body.replaceChildren();
    for (const key of [...refreshers.keys()]) if (rowSection.get(key) === section.id) refreshers.delete(key);
    if (open !== section.id) {
      body.hidden = true;
      return;
    }
    body.hidden = false;
    const win = windows.get(section.id)!;
    const end = Math.min(section.rows.length, win.start + Math.min(win.size, maxRows));
    const slice = section.rows.slice(win.start, end);
    paintedRows = slice.length;
    let group: string | null = null;
    let list: HTMLElement = body;
    let folded: HTMLElement | null = null;
    for (const row of slice) {
      if (section.grouping !== 'none' && row.group !== group) {
        group = row.group;
        if (section.grouping === 'folded') {
          const details = make('details', 'group');
          const count = slice.filter((r) => r.group === group).length;
          details.append(make('summary', 'group-title', `${group} (${formatCount(count)})`));
          folded = make('ul', 'rows');
          details.append(folded);
          body.append(details);
          list = folded;
        } else {
          body.append(make('h4', 'group-title', group));
          list = make('ul', 'rows');
          body.append(list);
        }
      } else if (section.grouping === 'none' && list === body) {
        list = make('ul', 'rows');
        body.append(list);
      }
      list.append(renderRow(section.id, row));
    }
    if (section.rows.length > pageRows) {
      const pager = make('div', 'pager');
      pager.append(make('span', 'pager-range', `Mostrando ${formatCount(win.start + 1)}–${formatCount(end)} de ${formatCount(section.rows.length)}`));
      if (win.start > 0) {
        pager.append(button(PREVIOUS_BUTTON, () => { win.start = Math.max(0, win.start - pageRows); renderBody(section); }));
      }
      if (end < section.rows.length) {
        pager.append(
          button(MORE_BUTTON, () => {
            if (win.size < maxRows) win.size = Math.min(maxRows, win.size + pageRows);
            else win.start += pageRows;
            renderBody(section);
          })
        );
      }
      body.append(pager);
    }
  }

  const rowSection = new Map<string, SectionId>();

  function renderRow(sectionId: SectionId, row: Row): HTMLElement {
    const item = make('li', 'row');
    item.dataset.row = row.id;
    rowSection.set(row.id, sectionId);
    if (row.kind === 'link') renderLinkRow(item, row);
    else if (row.kind === 'description') renderDescriptionRow(item, row);
    else if (row.kind === 'folder') renderFolderRow(item, row);
    else renderOrphanRow(item, row);
    return item;
  }

  function titleLine(item: HTMLElement, title: string, noteId: string): void {
    const head = make('div', 'row-head');
    head.append(make('strong', 'row-title', title === '' ? '(sin título)' : title));
    const open = button('Abrir', () => host.openNote(noteId), 'open');
    open.setAttribute('aria-label', `Abrir ${title}`);
    head.append(open);
    item.append(head);
  }

  function previewBox(): { box: HTMLElement; show(before: string | null, after: string | null): void } {
    const box = make('div', 'preview');
    const before = make('p', 'preview-line');
    const after = make('p', 'preview-line');
    box.append(before, after);
    const line = (target: HTMLElement, label: string, text: string | null): void => {
      target.hidden = text === null;
      if (text === null) return;
      target.replaceChildren(make('span', 'preview-label', `${label}: `), make('code', 'preview-text', text));
    };
    return {
      box,
      show(b, a) {
        line(before, 'Antes', b);
        line(after, 'Después', a);
      }
    };
  }

  function renderLinkRow(item: HTMLElement, row: LinkRow): void {
    const f = row.finding;
    titleLine(item, f.sourceTitle, f.sourceId);
    const what = f.status === 'ambiguous' ? 'Enlace ambiguo' : 'Enlace roto';
    item.append(
      make('p', 'meta', `${what} a «${f.link.target}»${f.occurrences > 1 ? ` (${formatCount(f.occurrences)} veces en la nota)` : ''}`)
    );
    const preview = previewBox();
    item.append(preview.box);
    preview.show('Leyendo la línea…', null);
    const check = make('input');
    check.type = 'checkbox';
    const label = make('label', 'check');
    const labelText = make('span', undefined, 'Arreglar este enlace');
    label.append(check, labelText);
    const note = make('p', 'note');

    if (f.candidates.length === 0) {
      note.textContent = 'Ninguna nota se parece a este enlace.';
      item.append(note, button('Buscar', () => host.openSearch(f.link.target), 'search'));
      check.disabled = true;
      label.hidden = true;
    } else if (f.candidates.length === 1) {
      const c = f.candidates[0];
      const flags = [c.conflictCopy ? 'copia de conflicto' : '', c.changesJdNumber ? 'cambia el número JD' : ''].filter(Boolean);
      item.append(make('p', 'target', `Destino: ${c.note.title} (${c.folderPath || 'Biblioteca'})${flags.length ? ` — ${flags.join(', ')}` : ''}`));
    } else {
      const select = make('select', 'candidates');
      const selectLabel = make('label', 'select-label');
      selectLabel.append(make('span', undefined, 'Destino: '), select);
      const placeholder = doc.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Elige el destino…';
      select.append(placeholder);
      for (const c of f.candidates) {
        const option = doc.createElement('option');
        option.value = c.note.id;
        option.textContent = `${c.note.title} — ${c.folderPath || 'Biblioteca'}${c.conflictCopy ? ' (copia de conflicto)' : ''}`;
        select.append(option);
      }
      select.addEventListener('change', () => {
        chooseCandidate(model, row.id, select.value === '' ? null : select.value);
        refresh();
        refreshCounts();
      });
      item.append(selectLabel);
    }
    item.append(note, label);
    check.addEventListener('change', () => {
      setChecked(model, row.id, check.checked);
      refresh();
      refreshCounts();
    });

    let previewToken = 0;
    const loadPreview = (): void => {
      previewToken += 1;
      const token = previewToken;
      const key = f.key;
      void host
        .linkPreview(f.sourceId, key, row.fix)
        .then((result) => {
          if (!alive || token !== previewToken) return;
          if (result === null) preview.show('No se pudo leer la línea.', null);
          else preview.show(result.before, row.fix ? result.after : null);
        })
        .catch(() => alive && preview.show('No se pudo leer la línea.', null));
    };
    let shownFor: string | null | undefined;
    function refresh(): void {
      const fixable = row.fix !== null;
      check.checked = row.checked;
      check.disabled = !fixable;
      labelText.textContent = fixable ? 'Arreglar este enlace' : 'Sin arreglo: elige un destino';
      note.textContent = row.unwritable ? 'Ese título no se puede escribir en un enlace: no hay arreglo.' : '';
      if (f.candidates.length === 0) note.textContent = 'Ninguna nota se parece a este enlace.';
      if (shownFor !== row.chosen) {
        shownFor = row.chosen;
        loadPreview();
      }
      const select = item.querySelector('select');
      if (select) select.value = row.chosen ?? '';
    }
    refreshers.set(row.id, refresh);
    refresh();
  }

  function renderDescriptionRow(item: HTMLElement, row: DescriptionRow): void {
    titleLine(item, row.item.title, row.item.id);
    const preview = previewBox();
    preview.show('Sin descripción', row.item.proposal === null ? null : `descripcion: ${row.item.proposal}`);
    item.append(preview.box);
    if (row.item.proposal === null) {
      item.append(make('p', 'note', 'Sin propuesta'));
      return;
    }
    const check = make('input');
    check.type = 'checkbox';
    const label = make('label', 'check');
    label.append(check, make('span', undefined, 'Añadir esta descripción'));
    item.append(label);
    check.addEventListener('change', () => {
      setChecked(model, row.id, check.checked);
      refreshCounts();
    });
    refreshers.set(row.id, () => {
      check.checked = row.checked;
    });
    check.checked = row.checked;
  }

  function renderFolderRow(item: HTMLElement, row: FolderRow): void {
    const group = row.duplicate;
    item.append(make('p', 'meta', `Dentro de ${group.parentPath || 'Biblioteca'}: ${formatCount(group.folders.length)} carpetas con el mismo nombre`));
    const list = make('ul', 'folder-list');
    for (const folder of group.folders) {
      const li = make('li', 'folder');
      li.append(
        make('span', 'folder-name', `«${folder.name}» — ${folder.path} — ${formatCount(folder.noteCount)} ${folder.noteCount === 1 ? 'nota' : 'notas'}`),
        button('Ver carpeta', () => host.selectFolder(folder.id), 'open')
      );
      list.append(li);
    }
    item.append(list);
  }

  function renderOrphanRow(item: HTMLElement, row: OrphanRow): void {
    titleLine(item, row.note.title, row.note.id);
  }

  // ---- armado ----
  const counts = countsOf(model);
  if (isEmpty(counts)) {
    root.append(empty);
  } else {
    root.append(toolbar);
    for (const section of model.sections) {
      if (section.rows.length === 0) continue;
      const box = make('section', 'section');
      const h = make('h3', 'section-title');
      const toggle = make('button', 'section-toggle');
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', String(open === section.id));
      toggle.addEventListener('click', () => {
        open = section.id;
        for (const [id, other] of headings) other.setAttribute('aria-expanded', String(id === open));
        for (const s of model.sections) if (s.rows.length > 0) renderBody(s);
      });
      headings.set(section.id, toggle);
      h.append(toggle);
      const body = make('div', 'section-body');
      bodies.set(section.id, body);
      box.append(h, body);
      sectionsBox.append(box);
    }
    root.append(sectionsBox, footer);
    refreshCounts();
    for (const section of model.sections) if (section.rows.length > 0) renderBody(section);
  }
  el.append(root);

  return {
    model,
    painted: () => root.querySelectorAll('[data-row]').length || paintedRows,
    unmount() {
      alive = false;
      refreshers = new Map();
      root.remove();
    }
  };
}
