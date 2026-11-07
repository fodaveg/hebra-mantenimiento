// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { canonicalTitle, MAX_RENAMES, renameRegistry } from '../src/scan/renames';
import { makeFake, openTestDb } from './helpers';

describe('registro de renombrados', () => {
  it('canoniza el título viejo: NFKC, recortado y en minúsculas', async () => {
    expect(canonicalTitle('  ＡＢＣ  Ñandú ')).toBe('abc  ñandú');
    const fake = makeFake({});
    const registry = renameRegistry(await openTestDb(fake));
    await registry.record('  Título VIEJO ', 'n-1');
    expect(await registry.lookup('título viejo')).toBe('n-1');
    expect(await registry.lookup('TÍTULO viejo  ')).toBe('n-1');
    expect(await registry.lookup('otro')).toBeNull();
    await fake.dispose();
  });

  it('un título vacío no se anota y repetir uno lo actualiza sin duplicar', async () => {
    const fake = makeFake({});
    const registry = renameRegistry(await openTestDb(fake));
    await registry.record('   ', 'n-1');
    expect(await registry.count()).toBe(0);
    await registry.record('A', 'n-1');
    await registry.record('a', 'n-2');
    expect(await registry.count()).toBe(1);
    expect(await registry.lookup('A')).toBe('n-2');
    await fake.dispose();
  });

  it('respeta el tope: salen primero las más antiguas', async () => {
    const fake = makeFake({});
    // Reloj parado: el orden de inserción manda aunque todas lleguen en el mismo ms.
    const registry = renameRegistry(await openTestDb(fake), { max: 5, now: () => 1 });
    for (let i = 0; i < 8; i += 1) await registry.record(`titulo ${i}`, `n-${i}`);
    expect(await registry.count()).toBe(5);
    for (const gone of [0, 1, 2]) expect(await registry.lookup(`titulo ${gone}`)).toBeNull();
    for (const kept of [3, 4, 5, 6, 7]) expect(await registry.lookup(`titulo ${kept}`)).toBe(`n-${kept}`);
    await fake.dispose();
  });

  it('repetir un título lo rejuvenece: ya no es de los primeros en salir', async () => {
    const fake = makeFake({});
    const registry = renameRegistry(await openTestDb(fake), { max: 3, now: () => 1 });
    await registry.record('a', 'n-a');
    await registry.record('b', 'n-b');
    await registry.record('c', 'n-c');
    await registry.record('a', 'n-a2');
    await registry.record('d', 'n-d');
    expect(await registry.lookup('b')).toBeNull();
    expect(await registry.lookup('a')).toBe('n-a2');
    await fake.dispose();
  });

  it('el orden sobrevive a reabrir el registro (el contador sale de lo guardado)', async () => {
    const fake = makeFake({});
    const db = await openTestDb(fake);
    const first = renameRegistry(db, { max: 2, now: () => 1 });
    await first.record('a', 'n-a');
    await first.record('b', 'n-b');
    const reopened = renameRegistry(db, { max: 2, now: () => 1 });
    await reopened.record('c', 'n-c');
    expect(await reopened.lookup('a')).toBeNull();
    expect(await reopened.lookup('b')).toBe('n-b');
    await fake.dispose();
  });

  it('el tope por defecto es de 10.000 entradas', () => {
    expect(MAX_RENAMES).toBe(10_000);
  });
});
