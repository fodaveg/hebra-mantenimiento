// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { formatCount, mountPanel, progressText, summaryText } from '../src/panel';
import { ScanCancelledError, type ScanProgress, type ScanResult } from '../src/scan/types';

afterEach(() => {
  document.body.replaceChildren();
});

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const RESULT: ScanResult = {
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
    expect(summaryText(RESULT)).toBe(
      '4.050 notas revisadas (50 archivadas, 2 protegidas sin leer, 12 leídas, 4.036 ya conocidas).'
    );
  });
});

describe('mountPanel', () => {
  it('el botón está habilitado; revisar enseña el progreso y «Cancelar», y al acabar el recuento', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    let finish!: (r: ScanResult) => void;
    let emit!: (p: ScanProgress) => void;
    mountPanel(el, (_signal, onProgress) => {
      emit = onProgress;
      return new Promise<ScanResult>((resolve) => (finish = resolve));
    });
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

    finish(RESULT);
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
      return new Promise<ScanResult>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new ScanCancelledError()))
      );
    });
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
      return new Promise<ScanResult>(() => undefined);
    });
    el.querySelector<HTMLButtonElement>('.hebra-mantenimiento-run')!.click();
    unmount();
    expect(seen.aborted).toBe(true);
    expect(el.childNodes).toHaveLength(0);
  });
});
