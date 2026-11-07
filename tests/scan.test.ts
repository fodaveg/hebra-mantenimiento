// @vitest-environment happy-dom
//
// El recorrido de la biblioteca contra el host falso v2. Se CUENTAN llamadas, nunca milisegundos.
import { describe, expect, it } from 'vitest';
import { scanLibrary } from '../src/scan/scan';
import { ScanCancelledError, type ScanProgress, type ScanMarkdown } from '../src/scan/types';
import { countingVault, makeFake, markdownOf, seedNotes, testCache } from './helpers';

const noPause = (): Promise<void> => Promise.resolve();

describe('scanLibrary con 4.050 notas', () => {
  const shape = { live: 4000, archived: 50, trashed: 10 };

  it('termina; la 2.ª revisión sin cambios hace 0 lecturas; cambiar una nota hace 1', async () => {
    const fake = makeFake(seedNotes(shape));
    const cache = await testCache(fake);
    const { vault, calls } = countingVault(fake.api.vault);
    const deps = { vault, markdown: markdownOf(fake), cache };

    const first = await scanLibrary(deps, { pause: noPause });
    expect(first.notes).toHaveLength(4050);
    expect(first.stats).toMatchObject({ notes: 4050, archived: 50, locked: 0, reads: 4050, cacheHits: 0 });
    expect(calls.reads).toHaveLength(4050);
    expect(calls.maxInFlight).toBeLessThanOrEqual(4);
    // 20 páginas vivas + 1 de archivo, 21 lotes de resúmenes (4.050 / 200).
    expect(calls.pages).toBe(20 + 1);
    expect(calls.summaries).toBe(21);
    // Las de la papelera no están; las archivadas sí.
    expect(first.notes.some((n) => n.archivedAt !== null)).toBe(true);
    expect(first.notes.map((n) => n.id)).not.toContain('n-04050');
    expect(first.notes[0].analysis).toMatchObject({ hasDescription: true });
    expect(first.notes[0].analysis?.links.map((l) => l.target)).toEqual(['nota 1', 'nota rota 0']);

    calls.reads.length = 0;
    const second = await scanLibrary(deps, { pause: noPause });
    expect(calls.reads).toHaveLength(0);
    expect(second.stats).toMatchObject({ reads: 0, cacheHits: 4050 });

    fake.host.touchNote('n-00007', '# Nota 7 cambiada\n\n[[Otra]]\n');
    calls.reads.length = 0;
    const third = await scanLibrary(deps, { pause: noPause });
    expect(calls.reads).toEqual(['n-00007']);
    expect(third.stats).toMatchObject({ reads: 1, cacheHits: 4049 });
    expect(third.notes.find((n) => n.id === 'n-00007')?.analysis?.hasDescription).toBe(false);

    // Lo que ocupa la caché con 4.050 notas (se imprime para el informe).
    const bytes = await cache.sizeBytes();
    console.info(`CACHE_BYTES_4050=${bytes}`);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(4050 * 600);
    await fake.dispose();
  });

  it('prueba negativa: sin caché la 2.ª revisión vuelve a leer todo', async () => {
    const fake = makeFake(seedNotes({ live: 300 }));
    const { vault, calls } = countingVault(fake.api.vault);
    const deps = { vault, markdown: markdownOf(fake), cache: null };
    await scanLibrary(deps, { pause: noPause });
    calls.reads.length = 0;
    await scanLibrary(deps, { pause: noPause });
    expect(calls.reads).toHaveLength(300);
    await fake.dispose();
  });

  it('ningún trozo entre dos esperas analiza más de 50 cuerpos', async () => {
    const fake = makeFake(seedNotes(shape));
    const { vault } = countingVault(fake.api.vault);
    let sinceLastPause = 0;
    let most = 0;
    let pauses = 0;
    const markdown: ScanMarkdown = {
      frontmatter: (body) => markdownOf(fake).frontmatter(body),
      links: (body) => {
        sinceLastPause += 1;
        most = Math.max(most, sinceLastPause);
        return markdownOf(fake).links(body);
      }
    };
    await scanLibrary(
      { vault, markdown, cache: null },
      {
        pause: () => {
          pauses += 1;
          sinceLastPause = 0;
          return Promise.resolve();
        }
      }
    );
    expect(most).toBeLessThanOrEqual(50);
    expect(most).toBeGreaterThan(0);
    expect(pauses).toBe(Math.ceil(4050 / 50));
    await fake.dispose();
  });

  it('informa del progreso con números', async () => {
    const fake = makeFake(seedNotes({ live: 120 }));
    const seen: ScanProgress[] = [];
    await scanLibrary(
      { vault: fake.api.vault, markdown: markdownOf(fake), cache: null },
      { pause: noPause, onProgress: (p) => seen.push(p) }
    );
    expect(seen[0]).toEqual({ phase: 'folders', done: 0, total: 1 });
    expect(seen).toContainEqual({ phase: 'reading', done: 50, total: 120 });
    expect(seen.at(-1)).toEqual({ phase: 'reading', done: 120, total: 120 });
    await fake.dispose();
  });
});

describe('cancelar', () => {
  it('a mitad de las lecturas: no se pide ni una nota más y no hay resultado', async () => {
    const fake = makeFake(seedNotes({ live: 1000 }));
    const controller = new AbortController();
    const { vault, calls } = countingVault(fake.api.vault);
    let after = 0;
    let aborted = false;
    calls.onCall = (kind) => {
      if (aborted) after += 1;
      if (kind === 'read' && calls.reads.length === 120 && !aborted) {
        aborted = true;
        controller.abort();
      }
    };
    await expect(
      scanLibrary({ vault, markdown: markdownOf(fake), cache: null }, { signal: controller.signal, pause: noPause })
    ).rejects.toBeInstanceOf(ScanCancelledError);
    expect(aborted).toBe(true);
    expect(after).toBe(0);
    expect(calls.reads.length).toBeLessThan(121 + 4);
    await fake.dispose();
  });

  it('durante el listado: no pide más páginas', async () => {
    const fake = makeFake(seedNotes({ live: 1000 }));
    const controller = new AbortController();
    const { vault, calls } = countingVault(fake.api.vault);
    calls.onCall = (kind) => {
      if (kind === 'page' && calls.pages === 1) controller.abort();
    };
    await expect(
      scanLibrary({ vault, markdown: markdownOf(fake), cache: null }, { signal: controller.signal })
    ).rejects.toBeInstanceOf(ScanCancelledError);
    expect(calls.pages).toBe(2);
    expect(calls.summaries).toBe(0);
    expect(calls.reads).toHaveLength(0);
    await fake.dispose();
  });

  it('ya cancelada al empezar: no llama a nada', async () => {
    const fake = makeFake(seedNotes({ live: 10 }));
    const controller = new AbortController();
    controller.abort();
    const { vault, calls } = countingVault(fake.api.vault);
    await expect(
      scanLibrary({ vault, markdown: markdownOf(fake), cache: null }, { signal: controller.signal })
    ).rejects.toBeInstanceOf(ScanCancelledError);
    expect(calls.pages + calls.summaries + calls.reads.length).toBe(0);
    await fake.dispose();
  });
});

describe('qué notas entran y cuáles se leen', () => {
  it('las archivadas se listan, las de la papelera no, las protegidas no se leen', async () => {
    const fake = makeFake(seedNotes({ live: 30, archived: 5, trashed: 4 }));
    const { vault, calls } = countingVault(fake.api.vault);
    calls.locked = new Set(['n-00003', 'n-00031']);
    const result = await scanLibrary({ vault, markdown: markdownOf(fake), cache: null }, { pause: noPause });
    expect(result.notes).toHaveLength(35);
    expect(result.notes.filter((n) => n.archivedAt !== null)).toHaveLength(5);
    expect(result.notes.map((n) => n.id).filter((id) => Number(id.slice(2)) >= 35)).toEqual([]);
    expect(calls.reads).not.toContain('n-00003');
    expect(calls.reads).not.toContain('n-00031');
    expect(calls.reads).toHaveLength(33);
    const locked = result.notes.filter((n) => n.locked);
    expect(locked.map((n) => n.id).sort()).toEqual(['n-00003', 'n-00031']);
    expect(locked.every((n) => n.analysis === null)).toBe(true);
    expect(result.stats).toMatchObject({ locked: 2, archived: 5, reads: 33 });
    await fake.dispose();
  });
});
