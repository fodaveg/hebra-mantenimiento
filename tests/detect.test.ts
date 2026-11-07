// @vitest-environment happy-dom
//
// Los tres detectores de P4 (criterios 15 a 19) contra el recorrido del host falso.
import { describe, expect, it } from 'vitest';
import type { PluginFolder } from 'hebra-plugin-api/v2';
import type { FakeSeedNote } from 'hebra-plugin-api/testing';
import { detectMissingDescription } from '../src/detect/description';
import { detectDuplicateFolders } from '../src/detect/folders';
import { detectOrphans } from '../src/detect/orphans';
import { proposeDescription } from '../src/detect/proposal';
import { CACHE_VERSION } from '../src/scan/analyze';
import { ANALYSIS_STORE, idbCache } from '../src/scan/db';
import { scanLibrary } from '../src/scan/scan';
import { countingVault, makeFake, markdownOf, openTestDb } from './helpers';

const noPause = (): Promise<void> => Promise.resolve();

async function scan(notes: Record<string, FakeSeedNote>, locked: string[] = []) {
  const fake = makeFake(notes);
  const { vault, calls } = countingVault(fake.api.vault);
  for (const id of locked) calls.locked.add(id);
  const result = await scanLibrary({ vault, markdown: markdownOf(fake), cache: null }, { pause: noPause });
  return { fake, result, calls };
}

describe('sin descripción (15, 16, 17)', () => {
  const notes: Record<string, FakeSeedNote> = {
    a: { title: 'Sin nada', body: '# Sin nada\n\nEsto es *una* prueba con [[Enlace|alias]].\n\nOtro párrafo.' },
    b: { title: 'Con jd', body: '---\njd: 11.01\ndescripcion: \n---\n# Con jd\n\nTexto.' },
    c: { title: 'Sin prosa', body: '# Sin prosa\n\n- uno\n- dos\n\n```\ncódigo\n```\n' },
    d: { title: 'Descrita', body: '---\ndescripcion: Ya\n---\nTexto.' },
    e: { title: 'Archivada', body: 'Texto.', archivedAt: 5 },
    f: { title: 'Conflicto', body: 'Texto.', conflictOf: 'a' },
    g: { title: 'Protegida', body: 'Texto.' }
  };

  it('15: la propuesta exacta; 16: jd excluida; 17: sin prosa = sin propuesta; el resto, excluido', async () => {
    const { result, calls } = await scan(notes, ['g']);
    const found = detectMissingDescription(result);
    expect(found.map((n) => n.id).sort()).toEqual(['a', 'c']);
    expect(found.find((n) => n.id === 'a')?.proposal).toBe('Esto es una prueba con alias.');
    expect(found.find((n) => n.id === 'c')?.proposal).toBeNull();
    // Sin releer cuerpos al detectar: ninguna lectura más que las del recorrido.
    const reads = calls.reads.length;
    detectMissingDescription(result);
    expect(calls.reads).toHaveLength(reads);
  });

  it('prueba negativa: si la exclusión de jd se rompe, el criterio 16 falla', async () => {
    const { result } = await scan(notes, ['g']);
    const broken = {
      notes: result.notes.map((n) =>
        n.analysis ? { ...n, analysis: { ...n.analysis, hasJd: false } } : n
      )
    };
    // Con la exclusión rota, «Con jd» (descripcion vacía) sale: lo que el criterio 16 prohíbe.
    expect(detectMissingDescription(broken).map((n) => n.id)).toContain('b');
    expect(detectMissingDescription(result).map((n) => n.id)).not.toContain('b');
  });

  it('corte a 200: final de frase o último espacio con "..."', () => {
    const sentence = `${'a'.repeat(100)}. ${'b'.repeat(150)}`;
    expect(proposeDescription(sentence)).toBe(`${'a'.repeat(100)}.`);
    const words = Array.from({ length: 60 }, () => 'palabra').join(' ');
    const out = proposeDescription(words)!;
    expect(out.endsWith('...')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.slice(0, -3)).toMatch(/palabra$/);
    expect(proposeDescription('Corta.')).toBe('Corta.');
  });

  it('una caché con v: 1 se invalida', async () => {
    const fake = makeFake({ a: 'Texto de a.' });
    const db = await openTestDb(fake);
    const cache = idbCache(db);
    const stale = { sha256: 'x', v: CACHE_VERSION - 1, hasDescription: true, hasJd: false, proposedDescription: null, canWriteDescription: false, links: [] };
    const tx = db.transaction(ANALYSIS_STORE, 'readwrite');
    tx.objectStore(ANALYSIS_STORE).put(stale);
    await new Promise<void>((r) => (tx.oncomplete = () => r()));
    expect(CACHE_VERSION).toBe(3);
    expect((await cache.getMany(['x'])).size).toBe(0);
    await cache.putMany([{ ...stale, v: CACHE_VERSION }]);
    expect((await cache.getMany(['x'])).size).toBe(1);
  });
});

describe('carpetas duplicadas (18)', () => {
  const f = (id: string, parentId: string | null, name: string, noteCount = 0): PluginFolder => ({
    id, parentId, name, createdAt: 0, updatedAt: 0, noteCount
  });
  it('hermanas iguales tras NFC, recorte y minúsculas; no otros padres ni otros nombres', () => {
    const folders = [
      f('r1', null, 'Proyectos', 3),
      f('r2', null, 'proyectos ', 5),
      f('i1', null, '11 Viajes'),
      f('v1', 'i1', '11.01 Viajes'),
      f('v2', 'i1', '11.02 Viajes'),
      f('a1', null, '10 Casa'),
      f('a2', null, '20 Obra'),
      f('au1', 'a1', '40 Audits'),
      f('au2', 'a2', '40 Audits'),
      f('c1', null, 'Canción'),
      f('c2', null, 'Canción')
    ];
    const groups = detectDuplicateFolders(folders);
    expect(groups.map((g) => g.folders.map((x) => x.id))).toEqual([['c1', 'c2'], ['r1', 'r2']]);
    const proyectos = groups[1];
    expect(proyectos.folders).toEqual([
      { id: 'r1', name: 'Proyectos', path: 'Proyectos', noteCount: 3 },
      { id: 'r2', name: 'proyectos ', path: 'proyectos ', noteCount: 5 }
    ]);
  });
});

describe('sin enlaces entrantes (19)', () => {
  const idOf = (i: number): string => `n-${String(i).padStart(5, '0')}`;
  it('coincide con la lista calculada a mano en 50 notas', async () => {
    const notes: Record<string, FakeSeedNote> = {};
    const bodies: Record<number, string> = {
      0: '[[T 1]]',
      1: `[[id:${idOf(2)}]]`,
      2: '[[Sub/T 3|x]]',
      3: '[[T 3]] y [[t 4]]',
      4: '[[T 5]]', // archivada: cuenta como fuente
      5: '[[T 6]]', // protegida: no cuenta
      7: '[[T 7]]', // a sí misma: no cuenta
      10: '[[T 11]] [[T 12]]',
      30: '[[Dup]]' // ambiguo: enlaza a las dos
    };
    for (let i = 0; i < 50; i += 1) {
      const title = i === 20 || i === 21 ? 'Dup' : `T ${i}`;
      const body = bodies[i] ?? 'sin enlaces';
      notes[idOf(i)] =
        i === 4 ? { title, body, archivedAt: 9 } : i === 40 ? { title: 'Dup', body, conflictOf: idOf(20) } : { title, body };
    }
    const { result } = await scan(notes, [idOf(5)]);
    expect(result.notes).toHaveLength(50);
    // A mano: enlazadas = 1, 2, 3, 4, 5, 11, 12, 20, 21. Candidatas excluidas = 4 (archivada), 40 (conflicto).
    const linked = new Set([1, 2, 3, 4, 5, 11, 12, 20, 21]);
    const expected: string[] = [];
    for (let i = 0; i < 50; i += 1) if (!linked.has(i) && i !== 4 && i !== 40) expected.push(idOf(i));
    const groups = detectOrphans(result);
    const got = groups.flatMap((g) => g.notes.map((n) => n.id)).sort();
    expect(got).toEqual(expected);
    expect(got).toContain(idOf(6)); // su único enlace venía de una protegida
    expect(got).toContain(idOf(7)); // solo se enlaza a sí misma
    expect(new Set(groups.map((g) => g.folderId)).size).toBe(groups.length);
  });
});
