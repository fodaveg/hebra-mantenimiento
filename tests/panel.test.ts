// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHECKS,
  ERROR_TEXT,
  formatCount,
  mountPanel,
  PANEL_INTRO,
  PANEL_TITLE,
  progressText,
  STALE_TEXT,
  summaryText
} from '../src/panel';
import { analyze, type ReviewData } from '../src/results/model';
import { makeFake, scanOf, stubHost } from './helpers';
import { ScanCancelledError, type ScanProgress, type ScanResult } from '../src/scan/types';

afterEach(() => {
  document.body.replaceChildren();
});

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const SCAN: ScanResult = {
  folders: [],
  notes: [],
  stats: { notes: 4050, archived: 50, locked: 2, reads: 12, cacheHits: 4036 }
};

describe('textos', () => {
  it('agrupa los miles con punto', () => {
    expect(formatCount(1200)).toBe('1.200');
    expect(formatCount(4050)).toBe('4.050');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1234567)).toBe('1.234.567');
  });

  it('«Leyendo notas: 1.200 de 4.050»', () => {
    expect(progressText({ phase: 'reading', done: 1200, total: 4050 })).toBe('Leyendo notas: 1.200 de 4.050');
  });

  it('el recuento final', () => {
    expect(summaryText(SCAN)).toBe(
      '4.050 notas revisadas (50 archivadas, 2 protegidas sin leer, 12 leídas, 4.036 ya conocidas).'
    );
  });
});

describe('mountPanel', () => {
  it('el botón está habilitado; revisar enseña el progreso y «Cancelar», y al acabar el recuento', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    let finish!: (r: ReviewData) => void;
    let emit!: (p: ScanProgress) => void;
    mountPanel(el, (_signal, onProgress) => {
      emit = onProgress;
      return new Promise<ReviewData>((resolve) => (finish = resolve));
    }, stubHost().host);
    const run = el.querySelector<HTMLButtonElement>('.hebra-mantenimiento-run')!;
    const cancel = el.querySelector<HTMLButtonElement>('.hebra-mantenimiento-cancel')!;
    const status = el.querySelector('.hebra-mantenimiento-status')!;
    expect(run.disabled).toBe(false);
    expect(cancel.hidden).toBe(true);

    run.click();
    expect(run.disabled).toBe(true);
    expect(cancel.hidden).toBe(false);
    emit({ phase: 'reading', done: 1200, total: 4050 });
    expect(status.textContent).toBe('Leyendo notas: 1.200 de 4.050');
    expect(cancel.textContent).toBe('Cancelar');

    finish(await analyze(SCAN));
    await flush();
    expect(status.textContent).toContain('4.050 notas revisadas');
    expect(run.disabled).toBe(false);
    expect(cancel.hidden).toBe(true);
  });

  it('Cancelar aborta el recorrido y lo dice', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    let seen!: AbortSignal;
    mountPanel(el, (signal) => {
      seen = signal;
      return new Promise<ReviewData>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new ScanCancelledError()))
      );
    }, stubHost().host);
    el.querySelector<HTMLButtonElement>('.hebra-mantenimiento-run')!.click();
    el.querySelector<HTMLButtonElement>('.hebra-mantenimiento-cancel')!.click();
    await flush();
    expect(seen.aborted).toBe(true);
    expect(el.querySelector('.hebra-mantenimiento-status')!.textContent).toBe('Revisión cancelada.');
    expect(el.querySelector<HTMLButtonElement>('.hebra-mantenimiento-run')!.disabled).toBe(false);
  });

  it('cerrar la pestaña cancela lo que esté en marcha', () => {
    const el = document.createElement('div');
    document.body.append(el);
    let seen!: AbortSignal;
    const unmount = mountPanel(el, (signal) => {
      seen = signal;
      return new Promise<ReviewData>(() => undefined);
    }, stubHost().host);
    el.querySelector<HTMLButtonElement>('.hebra-mantenimiento-run')!.click();
    unmount();
    expect(seen.aborted).toBe(true);
    expect(el.childNodes).toHaveLength(0);
  });
});


describe('mountPanel: resultados, error y aviso de cambios', () => {
  it('sin hallazgos enseña «No hay nada que arreglar»', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    mountPanel(el, () => analyze(SCAN), stubHost().host);
    el.querySelector<HTMLButtonElement>('.hebra-mantenimiento-run')!.click();
    await flush();
    expect(el.textContent).toContain('No hay nada que arreglar');
  });

  it('un fallo de lectura dice «No se pudo leer la biblioteca.» y ofrece Reintentar', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    let fail = true;
    mountPanel(el, () => (fail ? Promise.reject(new Error('boom')) : analyze(SCAN)), stubHost().host);
    const run = el.querySelector<HTMLButtonElement>('.hebra-mantenimiento-run')!;
    run.click();
    await flush();
    expect(el.querySelector('.hebra-mantenimiento-status')!.textContent).toBe(ERROR_TEXT);
    expect(run.textContent).toBe('Reintentar');
    fail = false;
    run.click();
    await flush();
    expect(el.querySelector('.hebra-mantenimiento-status')!.textContent).toContain('notas revisadas');
    expect(run.textContent).toBe('Revisar la biblioteca');
  });

  it('si cambia la biblioteca con los resultados a la vista sale el aviso y «Revisar de nuevo» repite', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    const stub = stubHost();
    const scan = await scanOf(makeFake({ a: '# Sola\n\nUn párrafo sin descripción.\n' }));
    let runs = 0;
    mountPanel(el, () => (runs += 1, analyze(scan)), stub.host);
    const stale = el.querySelector<HTMLElement>('.hebra-mantenimiento-stale')!;
    stub.emitChange(); // aún no hay resultados: no avisa
    expect(stale.hidden).toBe(true);
    el.querySelector<HTMLButtonElement>('.hebra-mantenimiento-run')!.click();
    await flush();
    stub.emitChange();
    expect(stale.hidden).toBe(false);
    expect(stale.textContent).toContain(STALE_TEXT);
    stale.querySelector('button')!.click();
    await flush();
    expect(runs).toBe(2);
    expect(stale.hidden).toBe(true);
  });

  it('tras una revisión sin hallazgos, un cambio en la biblioteca no saca el aviso', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    const stub = stubHost();
    mountPanel(el, () => analyze(SCAN), stub.host);
    el.querySelector<HTMLButtonElement>('.hebra-mantenimiento-run')!.click();
    await flush();
    expect(el.textContent).toContain('No hay nada que arreglar');
    stub.emitChange();
    expect(el.querySelector<HTMLElement>('.hebra-mantenimiento-stale')!.hidden).toBe(true);
  });
});

describe('mountPanel: aspecto de Hebra (0.1.1)', () => {
  it('cabecera con título, una línea de qué hace y el botón principal; antes de revisar, qué revisa', () => {
    const el = document.createElement('div');
    document.body.append(el);
    mountPanel(el, () => new Promise<ReviewData>(() => undefined), stubHost().host);
    const head = el.querySelector('.hebra-mantenimiento-head')!;
    expect(head.querySelector('h1')!.textContent).toBe(PANEL_TITLE);
    expect(head.querySelector('.hebra-mantenimiento-intro')!.textContent).toBe(PANEL_INTRO);
    expect(head.querySelector('.hebra-mantenimiento-run')!.textContent).toBe('Revisar la biblioteca');
    const checks = el.querySelector<HTMLElement>('.hebra-mantenimiento-checks')!;
    expect(checks.hidden).toBe(false);
    expect([...checks.querySelectorAll('.hebra-mantenimiento-check-name')].map((n) => n.textContent)).toEqual(
      CHECKS.map(([name]) => name)
    );
    expect(checks.textContent).toContain('No cambia nada hasta que marcas un arreglo');
  });

  it('la barra sigue el paso con total y se queda indeterminada sin él; la tarjeta se va al revisar', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    let finish!: (r: ReviewData) => void;
    let emit!: (p: ScanProgress) => void;
    mountPanel(el, (_signal, onProgress) => {
      emit = onProgress;
      return new Promise<ReviewData>((resolve) => (finish = resolve));
    }, stubHost().host);
    const bar = el.querySelector<HTMLElement>('.hebra-mantenimiento-bar')!;
    const checks = el.querySelector<HTMLElement>('.hebra-mantenimiento-checks')!;
    expect(bar.hidden).toBe(true);
    el.querySelector<HTMLButtonElement>('.hebra-mantenimiento-run')!.click();
    expect(checks.hidden).toBe(true);
    expect(bar.hidden).toBe(false);
    expect(bar.getAttribute('role')).toBe('progressbar');
    expect(bar.dataset.indeterminate).toBe('true');
    emit({ phase: 'listing', done: 300, total: 0 });
    expect(bar.hasAttribute('aria-valuenow')).toBe(false);
    emit({ phase: 'reading', done: 1200, total: 4050 });
    expect(bar.getAttribute('aria-valuenow')).toBe('30');
    expect(bar.dataset.indeterminate).toBeUndefined();
    expect(el.querySelector<HTMLElement>('.hebra-mantenimiento-bar-fill')!.style.width).toBe('30%');
    finish(await analyze(SCAN));
    await flush();
    expect(bar.hidden).toBe(true);
    expect(checks.hidden).toBe(true);
  });

  it('al cancelar sin resultados vuelve la tarjeta de qué revisa', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    mountPanel(el, (signal) =>
      new Promise<ReviewData>((_resolve, reject) => signal.addEventListener('abort', () => reject(new ScanCancelledError()))),
    stubHost().host);
    el.querySelector<HTMLButtonElement>('.hebra-mantenimiento-run')!.click();
    el.querySelector<HTMLButtonElement>('.hebra-mantenimiento-cancel')!.click();
    await flush();
    expect(el.querySelector<HTMLElement>('.hebra-mantenimiento-checks')!.hidden).toBe(false);
  });

  it('con la hoja del plugin, lo oculto con `hidden` no se ve aunque su clase ponga `display` (el aviso de 0.1.0)', () => {
    const style = document.createElement('style');
    // vitest corre desde la raíz del repo.
    style.textContent = readFileSync(join(cwd(), 'src', 'hebra-styles.css'), 'utf8');
    document.head.append(style);
    try {
      const el = document.createElement('div');
      document.body.append(el);
      mountPanel(el, () => new Promise<ReviewData>(() => undefined), stubHost().host);
      const stale = el.querySelector<HTMLElement>('.hebra-mantenimiento-stale')!;
      expect(stale.hidden).toBe(true);
      expect(getComputedStyle(stale).display).toBe('none');
      stale.hidden = false;
      expect(getComputedStyle(stale).display).toBe('flex');
    } finally {
      style.remove();
    }
  });
});
