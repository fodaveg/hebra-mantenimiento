// @vitest-environment happy-dom
//
// La pestaña de resultados (P5): secciones, recuentos, casillas, candidatos y el tope de filas.
import type { FakeSeedNote } from 'hebra-plugin-api/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { analyze, applyLabel, countsOf, type ReviewData } from '../src/results/model';
import { linePreview } from '../src/results/preview';
import { MAX_PAINTED_ROWS, mountResults, MORE_BUTTON } from '../src/results/view';
import { keyOf } from '../src/detect/links';
import { applyChecked } from '../src/apply/apply';
import { makeFake, markdownOf, scanOf, stubHost } from './helpers';

afterEach(() => {
  document.body.replaceChildren();
});

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function reviewOf(notes: Record<string, FakeSeedNote>, setup?: (fake: ReturnType<typeof makeFake>) => Promise<void>): Promise<{ review: ReviewData; fake: ReturnType<typeof makeFake> }> {
  const fake = makeFake(notes);
  await setup?.(fake);
  return { review: await analyze(await scanOf(fake)), fake };
}

const mount = (review: ReviewData, maxRows?: number) => {
  const el = document.createElement('div');
  document.body.append(el);
  const stub = stubHost();
  const mounted = mountResults(el, review, stub.host, maxRows ? { maxRows } : {});
  return { el, mounted, ...stub };
};

const headings = (el: HTMLElement): string[] => [...el.querySelectorAll('.hebra-mantenimiento-section-toggle')].map((h) => h.textContent ?? '');
const rowsOf = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll<HTMLElement>('[data-row]')];
const buttonByText = (el: HTMLElement, text: string): HTMLButtonElement =>
  [...el.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement;

/** Una biblioteca con un poco de todo. */
async function varied() {
  return reviewOf(
    {
      o1: '---\ndescripcion: x\n---\n# Origen uno\n\n[[Cancion]] y [[Cancion]]\n',
      o2: '---\ndescripcion: x\n---\n# Origen dos\n\n[[Nada parecido]]\n',
      o3: '---\ndescripcion: x\n---\n# Origen tres\n\n[[11.01 Viajes]]\n',
      o4: '---\ndescripcion: x\n---\n# Origen cuatro\n\n[[Plan x]]\n',
      c1: '---\ndescripcion: x\n---\n# Canción\n',
      v1: '---\ndescripcion: x\n---\n# 11.05 Viajes\n',
      sin: '# Sin descripcion\n\nUn párrafo de prosa.\n',
      'sin-prosa': '# Sin prosa\n\n- solo lista\n'
    },
    async (fake) => {
      const a = await fake.api.vault.folderCreate(null, 'A');
      const b = await fake.api.vault.folderCreate(null, 'B');
      await fake.api.vault.folderCreate(null, 'Proyectos');
      await fake.api.vault.folderCreate(null, 'proyectos ');
      await fake.api.vault.noteCreate({ folderId: a.id, body: '---\ndescripcion: x\n---\n# Plan X\n' });
      await fake.api.vault.noteCreate({ folderId: b.id, body: '---\ndescripcion: x\n---\n# Plan X\n' });
    }
  );
}

describe('secciones y recuentos', () => {
  it('cuatro encabezados con su recuento en texto', async () => {
    const { review } = await varied();
    const { el } = mount(review);
    const [links, descriptions, folders, orphans] = headings(el);
    expect(links).toBe('Enlaces rotos (4, 1 con arreglo marcado)');
    expect(descriptions).toBe('Sin descripción (2)');
    expect(folders).toBe('Carpetas duplicadas (1)');
    expect(orphans).toMatch(/^Sin enlaces entrantes \(\d+\)$/);
  });

  it('una fila marcada (seguro) y otra sin marcar (cambia el número JD); la sin candidatos no tiene casilla activa', async () => {
    const { review } = await varied();
    const { el } = mount(review);
    const row = (text: string): HTMLElement => rowsOf(el).find((r) => r.textContent?.includes(text))!;
    const safe = row('Origen uno');
    const jd = row('Origen tres');
    const none = row('Origen dos');
    expect(safe.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(true);
    expect(jd.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(false);
    expect(jd.textContent).toContain('cambia el número JD');
    expect(jd.querySelector<HTMLInputElement>('input[type=checkbox]')!.disabled).toBe(false);
    expect(none.textContent).toContain('Ninguna nota se parece');
    expect(none.querySelector('label')!.hidden).toBe(true);
    expect(buttonByText(none as HTMLElement, 'Buscar')).toBeTruthy();
    expect(safe.textContent).toContain('2 veces en la nota');
  });

  it('las vistas previas enseñan antes y después', async () => {
    const { review } = await varied();
    const { el, calls } = mount(review);
    await flush();
    const safe = rowsOf(el).find((r) => r.textContent?.includes('Origen uno'))!;
    expect(safe.textContent).toContain('Antes: antes cancion');
    expect(safe.textContent).toContain('Después: después Canción');
    expect(calls.previews.some((p) => p.startsWith('o1|cancion|Canción'))).toBe(true);
  });

  it('el botón Aplicar dice cuántos cambios en cuántas notas y está habilitado si hay algo marcado', async () => {
    const { review } = await varied();
    const { el } = mount(review);
    const apply = el.querySelector<HTMLButtonElement>('.hebra-mantenimiento-apply')!;
    expect(apply.textContent).toBe('Aplicar 2 cambios en 1 nota');
    expect(apply.disabled).toBe(false);
    buttonByText(el, 'Desmarcar todo').click();
    expect(apply.disabled).toBe(true);
  });

  it('sin hallazgos: «No hay nada que arreglar»', async () => {
    const { review } = await reviewOf({ a: '---\ndescripcion: x\n---\n# A\n\n[[B]]\n', b: '---\ndescripcion: x\n---\n# B\n\n[[A]]\n' });
    const { el } = mount(review);
    expect(el.textContent).toContain('No hay nada que arreglar');
    expect(el.querySelector('.hebra-mantenimiento-section')).toBeNull();
  });
});

describe('elegir candidato', () => {
  it('el selector enseña título y ruta; elegir uno marca la fila y sube el recuento', async () => {
    const { review } = await varied();
    const { el, mounted } = mount(review);
    const row = rowsOf(el).find((r) => r.textContent?.includes('Origen cuatro'))!;
    const select = row.querySelector('select')!;
    const options = [...select.options].map((o) => o.textContent);
    expect(options).toEqual(['Elige el destino…', 'Plan X — A', 'Plan X — B']);
    const box = row.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(true);

    select.value = select.options[1].value;
    select.dispatchEvent(new Event('change'));
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(false);
    expect(headings(el)[0]).toBe('Enlaces rotos (4, 2 con arreglo marcado)');
    expect(el.querySelector('.hebra-mantenimiento-apply')!.textContent).toBe('Aplicar 3 cambios en 2 notas');
    const model = mounted.model;
    const linkRow = model.sections[0].rows.find((r) => r.kind === 'link' && r.finding.sourceTitle === 'Origen cuatro');
    expect(linkRow?.kind === 'link' && linkRow.fix?.newTarget).toBe('A/Plan X');
    await flush();
    expect(row.textContent).toContain('Después: después A/Plan X');
  });

  it('la copia de conflicto sale etiquetada', async () => {
    const { review } = await reviewOf({
      o: '---\ndescripcion: x\n---\n# O\n\n[[Título]]\n',
      t: '---\ndescripcion: x\n---\n# Título\n',
      tc: { body: '---\ndescripcion: x\n---\n# Título\n', conflictOf: 't' }
    });
    const { el } = mount(review);
    const labels = [...el.querySelectorAll('select option')].map((o) => o.textContent);
    expect(labels.some((l) => l?.includes('(copia de conflicto)'))).toBe(true);
  });
});

describe('marcar y desmarcar', () => {
  it('«Desmarcar todo» vacía las casillas y «Marcar todo lo seguro» vuelve a las seguras, sin tocar las de criterio', async () => {
    const { review } = await varied();
    const { el } = mount(review);
    const select = rowsOf(el).find((r) => r.textContent?.includes('Origen cuatro'))!.querySelector('select')!;
    select.value = select.options[1].value;
    select.dispatchEvent(new Event('change'));
    expect(el.querySelector('.hebra-mantenimiento-apply')!.textContent).toBe('Aplicar 3 cambios en 2 notas');

    buttonByText(el, 'Desmarcar todo').click();
    expect(el.querySelector('.hebra-mantenimiento-apply')!.textContent).toBe('Aplicar cambios');
    expect(headings(el)[0]).toBe('Enlaces rotos (4, 0 con arreglo marcado)');
    expect(rowsOf(el).every((r) => [...r.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].every((c) => !c.checked))).toBe(true);

    buttonByText(el, 'Marcar todo lo seguro').click();
    expect(el.querySelector('.hebra-mantenimiento-apply')!.textContent).toBe('Aplicar 2 cambios en 1 nota');
    expect(headings(el)[0]).toBe('Enlaces rotos (4, 1 con arreglo marcado)');
  });

  it('una descripción propuesta empieza sin marcar; la que no tiene propuesta no tiene casilla', async () => {
    const { review } = await varied();
    const { el } = mount(review);
    buttonByText(el, 'Sin descripción (2)').click();
    const sin = rowsOf(el).find((r) => r.textContent?.includes('Sin descripcion'))!;
    const sinProsa = rowsOf(el).find((r) => r.textContent?.includes('Sin prosa'))!;
    const box = sin.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    expect(box.checked).toBe(false);
    expect(sin.textContent).toContain('descripcion: Un párrafo de prosa.');
    expect(sinProsa.querySelector('input')).toBeNull();
    expect(sinProsa.textContent).toContain('Sin propuesta');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(el.querySelector('.hebra-mantenimiento-apply')!.textContent).toBe('Aplicar 3 cambios en 2 notas');
  });
});

describe('botones de Hebra', () => {
  it('Abrir, Buscar y Ver carpeta', async () => {
    const { review } = await varied();
    const { el, calls } = mount(review);
    const none = rowsOf(el).find((r) => r.textContent?.includes('Origen dos'))!;
    buttonByText(none, 'Abrir').click();
    buttonByText(none, 'Buscar').click();
    expect(calls.opened).toEqual(['o2']);
    expect(calls.searched).toEqual(['nada parecido']);
    buttonByText(el, 'Carpetas duplicadas (1)').click();
    const folderRow = rowsOf(el)[0];
    expect(folderRow.textContent).toContain('«Proyectos»');
    expect(folderRow.textContent).toContain('«proyectos »');
    expect(folderRow.textContent).toContain('0 notas');
    buttonByText(folderRow, 'Ver carpeta').click();
    expect(calls.folders).toHaveLength(1);
  });

  it('sin enlaces entrantes: agrupadas por carpeta y plegadas', async () => {
    const { review } = await varied();
    const { el } = mount(review);
    buttonByText(el, headings(el)[3]).click();
    const groups = [...el.querySelectorAll('details')];
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every((g) => !g.open)).toBe(true);
  });

  it('solo hay una sección desplegada a la vez', async () => {
    const { review } = await varied();
    const { el } = mount(review);
    const bodies = (): boolean[] => [...el.querySelectorAll<HTMLElement>('.hebra-mantenimiento-section-body')].map((b) => !b.hidden);
    expect(bodies()).toEqual([true, false, false, false]);
    buttonByText(el, 'Sin descripción (2)').click();
    expect(bodies()).toEqual([false, true, false, false]);
  });
});

describe('tope de filas pintadas', () => {
  const thousand = (): Record<string, FakeSeedNote> => {
    const notes: Record<string, FakeSeedNote> = {};
    for (let i = 0; i < 1000; i += 1) notes[`n-${String(i).padStart(4, '0')}`] = `---\ndescripcion: x\n---\n# Nota ${i}\n\n[[Rota ${i}]]\n`;
    return notes;
  };

  it('con 1.000 hallazgos nunca hay más de 200 filas pintadas, ni deslizando la ventana', async () => {
    const { review } = await reviewOf(thousand());
    const { el, mounted } = mount(review);
    expect(headings(el)[0]).toBe('Enlaces rotos (1.000, 0 con arreglo marcado)');
    const seen: number[] = [rowsOf(el).length];
    expect(seen[0]).toBe(100);
    for (let i = 0; i < 8; i += 1) {
      buttonByText(el, MORE_BUTTON).click();
      seen.push(rowsOf(el).length);
      expect(mounted.painted()).toBeLessThanOrEqual(MAX_PAINTED_ROWS);
    }
    expect(seen.slice(0, 3)).toEqual([100, 200, 200]);
    expect(Math.max(...seen)).toBe(200);
    // La ventana avanzó: ya no se ve la primera nota.
    expect(rowsOf(el).some((r) => r.textContent?.includes('Nota 0 ') || r.dataset.row?.startsWith('n-0000'))).toBe(false);
    expect(el.textContent).toMatch(/Mostrando \d+.*de 1\.000/);
  });

  it('prueba negativa: sin el tope (maxRows enorme) el mismo recorrido SÍ pinta más de 200', async () => {
    const { review } = await reviewOf(thousand());
    const { el } = mount(review, 5000);
    for (let i = 0; i < 4; i += 1) buttonByText(el, MORE_BUTTON).click();
    expect(rowsOf(el).length).toBeGreaterThan(MAX_PAINTED_ROWS);
  });
});

describe('modelo', () => {
  it('applyLabel concuerda singular y plural', () => {
    const base = { links: 0, linksChecked: 0, descriptions: 0, duplicates: 0, orphans: 0 };
    expect(applyLabel({ ...base, changes: 0, notes: 0 })).toBe('Aplicar cambios');
    expect(applyLabel({ ...base, changes: 1, notes: 1 })).toBe('Aplicar 1 cambio en 1 nota');
    expect(applyLabel({ ...base, changes: 15, notes: 12 })).toBe('Aplicar 15 cambios en 12 notas');
    void countsOf;
  });

  it('linePreview: la línea del enlace antes y después, sin tocar las demás', async () => {
    const fake = makeFake({});
    const body = 'Uno\n\nVer [[Cancion#Letra|la canción]] ahora.\n\nTres\n';
    const links = fake.api.markdown.links(body);
    const key = keyOf({ ...links[0], target: links[0].target! });
    expect(linePreview(body, links, key, { newTarget: 'Canción', addAlias: false, resolvesToOnlyTarget: true })).toEqual({
      before: 'Ver [[Cancion#Letra|la canción]] ahora.',
      after: 'Ver [[Canción#Letra|la canción]] ahora.'
    });
    expect(linePreview(body, links, key, null)?.after).toBe('Ver [[Cancion#Letra|la canción]] ahora.');
    expect(linePreview('nada', [], key, null)).toBeNull();
    await fake.dispose();
  });
});


describe('aplicar desde la pestaña', () => {
  const mountApplying = (fake: ReturnType<typeof makeFake>, review: ReviewData) => {
    const el = document.createElement('div');
    document.body.append(el);
    const stub = stubHost((model) =>
      applyChecked(model, { vault: fake.api.vault, markdown: markdownOf(fake), isLockedError: (e) => (e as { code?: string })?.code === 'note-locked' })
    );
    const mounted = mountResults(el, review, stub.host);
    return { el, mounted, ...stub };
  };

  it('«Aplicando…» mientras escribe; después el resumen con el foco, «Hecho» con «Deshacer desde la nota» y los recuentos al día', async () => {
    const { review, fake } = await varied();
    const { el, calls } = mountApplying(fake, review);
    const apply = el.querySelector<HTMLButtonElement>('.hebra-mantenimiento-apply')!;
    apply.click();
    expect(apply.textContent).toBe('Aplicando…');
    expect(apply.disabled).toBe(true);
    expect(buttonByText(el, 'Desmarcar todo').disabled).toBe(true);
    await flush();
    await flush();
    const summary = el.querySelector<HTMLElement>('.hebra-mantenimiento-summary')!;
    expect(summary.textContent).toBe('Aplicados 2 cambios en 1 nota.');
    expect(summary.dataset.state).toBe('done');
    expect(document.activeElement).toBe(summary);
    const row = rowsOf(el).find((r) => r.textContent?.includes('Origen uno'))!;
    expect(row.textContent).toContain('✓ Hecho');
    buttonByText(row, 'Deshacer desde la nota').click();
    expect(calls.opened).toEqual(['o1']);
    expect(headings(el)[0]).toBe('Enlaces rotos (3, 0 con arreglo marcado)');
    expect(apply.textContent).toBe('Aplicar cambios');
    expect(apply.disabled).toBe(true);
    expect((await fake.api.vault.noteRead('o1'))!.body).toContain('[[Canción]] y [[Canción]]');
  });

  it('una nota que cambió mientras tanto lleva su motivo y el resumen avisa (aplicado con avisos)', async () => {
    const { review, fake } = await varied();
    const { el } = mountApplying(fake, review);
    // La fila de «Origen cuatro» se marca eligiendo destino; «Origen uno» ya iba marcada.
    const select = rowsOf(el).find((r) => r.textContent?.includes('Origen cuatro'))!.querySelector('select')!;
    select.value = select.options[1].value;
    select.dispatchEvent(new Event('change'));
    fake.host.touchNote('o4', '---\ndescripcion: x\n---\n# Origen cuatro\n\n[[Plan x]] editada\n');
    el.querySelector<HTMLButtonElement>('.hebra-mantenimiento-apply')!.click();
    await flush();
    await flush();
    const summary = el.querySelector<HTMLElement>('.hebra-mantenimiento-summary')!;
    expect(summary.textContent).toBe('Aplicados 2 cambios en 1 nota. 1 nota cambió mientras tanto y no se tocó.');
    expect(summary.dataset.state).toBe('with-warnings');
    const failedRow = rowsOf(el).find((r) => r.textContent?.includes('Origen cuatro'))!;
    expect(failedRow.textContent).toContain('✗ Cambió desde la revisión: no se tocó');
    expect(failedRow.querySelector<HTMLInputElement>('input[type=checkbox]')!.disabled).toBe(true);
  });

  it('«Sin enlaces entrantes» se actualiza: la nota a la que ahora llega un enlace deja de ser huérfana', async () => {
    const { review, fake } = await varied();
    const { el } = mountApplying(fake, review);
    const count = (): number => Number(/\((\d+)\)/.exec(headings(el)[3])![1]);
    const titles = (): string[] => review.orphans.flatMap((g) => g.notes).map((n) => n.title);
    expect(titles()).toContain('Canción');
    const before = count();
    el.querySelector<HTMLButtonElement>('.hebra-mantenimiento-apply')!.click();
    await flush();
    await flush();
    expect(titles()).not.toContain('Canción');
    expect(count()).toBe(before - 1);
  });
});
