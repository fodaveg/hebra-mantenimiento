// @vitest-environment happy-dom
//
// Aplicar (P6) contra el host falso v2: criterios 1, 2, 4, 9, 10, 12 y 15 de docs/SPEC.md, el
// reintento por `note-locked`, el reparto en lotes de 200 y que `noteSave` no se llama nunca.
import type { FakeSeedNote } from 'hebra-plugin-api/testing';
import type { PluginNoteRevision, PluginVault } from 'hebra-plugin-api/v2';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { applyChecked, causeOf, REASON_TEXT, type ApplyDeps, type ApplyMarkdown } from '../src/apply/apply';
import { createOwnWrites } from '../src/apply/own-writes';
import { analyze, buildModel, chooseCandidate, setChecked, sectionOf, type LinkRow, type ResultsModel } from '../src/results/model';
import { appliedSummary } from '../src/results/view';
import { openDb } from '../src/scan/db';
import { renameRegistry } from '../src/scan/renames';
import { makeFake, markdownOf, scanOf } from './helpers';

type Fake = ReturnType<typeof makeFake>;

interface Spy {
  vault: ApplyDeps['vault'];
  batches: { ids: string[]; options: unknown; strict: boolean[] }[];
  saves: number;
  reads: string[];
  locked: Set<string>;
  gone: Set<string>;
  /** Se ejecuta tras leer una nota y antes de escribir (para cambiarla «entre medias»). */
  afterRead?: (id: string) => void;
}

/** Envuelve el almacén: cuenta lo que se llama, simula protegidas y `note-locked` como Hebra. */
function spy(fake: Fake): Spy {
  const real = fake.api.vault as PluginVault;
  const s: Spy = { vault: undefined as never, batches: [], saves: 0, reads: [], locked: new Set(), gone: new Set() };
  s.vault = {
    noteRead: async (id) => {
      s.reads.push(id);
      if (s.gone.has(id)) return null;
      const note = await real.noteRead(id);
      const lockedNow = s.locked.has(id);
      s.afterRead?.(id);
      return note && lockedNow ? { ...note, locked: true, body: null } : note;
    },
    noteSummary: async (ids) => (await real.noteSummary(ids)).filter((n) => !s.gone.has(n.id)).map((n) => (s.locked.has(n.id) ? { ...n, locked: true } : n)),
    notesRewriteBatch: async (entries, options) => {
      s.batches.push({ ids: entries.map((e) => e.id), options, strict: entries.map((e) => e.strictRevision === true) });
      if (entries.some((e) => s.locked.has(e.id))) {
        throw Object.assign(new Error('nota protegida'), { name: 'PluginApiError', code: 'note-locked' });
      }
      return real.notesRewriteBatch(entries, options);
    }
  };
  // Todo lo demás del almacén pasa al real; `noteSave` queda contado por si el código lo llamara.
  const custom = s.vault as unknown as Record<string, unknown>;
  s.vault = new Proxy(custom, {
    get(target, key) {
      if (key in target) return target[key as string];
      if (key === 'noteSave') {
        return (...args: Parameters<PluginVault['noteSave']>) => {
          s.saves += 1;
          return real.noteSave(...args);
        };
      }
      return Reflect.get(real, key) as unknown;
    }
  }) as unknown as ApplyDeps['vault'];
  return s;
}

const deps = (fake: Fake, s: Spy, markdown: ApplyMarkdown = markdownOf(fake)): ApplyDeps => ({
  vault: s.vault,
  markdown,
  isLockedError: (e) => (e as { code?: string })?.code === 'note-locked'
});

async function prepare(fake: Fake, rename?: [string, string][]): Promise<ResultsModel> {
  const scan = await scanOf(fake);
  let lookup: ((t: string) => Promise<string | null>) | undefined;
  if (rename) {
    const registry = renameRegistry(await openDb({ indexedDB: new IDBFactory(), name: 'x' }));
    for (const [title, id] of rename) await registry.record(title, id);
    lookup = (t) => registry.lookup(t);
  }
  return buildModel(await analyze(scan, lookup));
}

const bodyOf = async (fake: Fake, id: string): Promise<string> => (await fake.api.vault.noteRead(id))!.body!;
const revisionOf = async (fake: Fake, id: string): Promise<PluginNoteRevision> => (await fake.api.vault.noteRead(id))!.revision;
const linkRows = (model: ResultsModel): LinkRow[] => sectionOf(model, 'links').rows as LinkRow[];
const FM = '---\ndescripcion: x\n---\n';

describe('1. y 4. de extremo a extremo', () => {
  it('1: [[Plan viejo]] renombrado queda [[Plan 2027]] y nada más cambia', async () => {
    const source = `${FM}# Origen\n\nAntes\n\nVer [[Plan viejo]] y [[Plan viejo]].\n\nFin\n`;
    const fake = makeFake({ o: source, p: `${FM}# Plan 2027\n` });
    const s = spy(fake);
    const model = await prepare(fake, [['plan viejo', 'p']]);
    expect(linkRows(model)[0].checked).toBe(true);
    const report = await applyChecked(model, deps(fake, s));
    expect(await bodyOf(fake, 'o')).toBe(source.split('[[Plan viejo]]').join('[[Plan 2027]]'));
    expect(report).toMatchObject({ changes: 2, notes: 1, failedRows: 0, batches: 1 });
    expect(s.saves).toBe(0);
    expect(linkRows(model)[0].outcome).toEqual({ state: 'done', text: 'Hecho' });
    await fake.dispose();
  });

  it('2: elegir uno de dos «Canción» escribe [[Carpeta/Canción|Cancion]] y resuelve a una sola nota', async () => {
    const fake = makeFake({ o: `${FM}# O\n\n[[Cancion]]\n` });
    const a = await fake.api.vault.folderCreate(null, 'Carpeta');
    const b = await fake.api.vault.folderCreate(null, 'Otra');
    const na = await fake.api.vault.noteCreate({ folderId: a.id, body: `${FM}# Canción\n` });
    await fake.api.vault.noteCreate({ folderId: b.id, body: `${FM}# Canción\n` });
    const s = spy(fake);
    const model = await prepare(fake);
    const row = linkRows(model)[0];
    expect(row.checked).toBe(false);
    chooseCandidate(model, row.id, na.id);
    expect(row.checked).toBe(true);
    await applyChecked(model, deps(fake, s));
    expect(await bodyOf(fake, 'o')).toBe(`${FM}# O\n\n[[Carpeta/Canción|Cancion]]\n`);
    // Vuelve a revisar: el enlace ya no sale.
    const again = await analyze(await scanOf(fake));
    expect(again.links.filter((f) => f.sourceId === 'o')).toEqual([]);
    expect(s.saves).toBe(0);
    await fake.dispose();
  });

  it('4: conserva #Sección, alias, ! y #^bloque al aplicar', async () => {
    const source = `${FM}# O\n\n[[Nota vieja#Sección|texto]] y ![[Nota vieja]] y [[Nota vieja#^bloque]]\n`;
    const fake = makeFake({ o: source, n: `${FM}# Nota nueva\n` });
    const s = spy(fake);
    const model = await prepare(fake, [['nota vieja', 'n']]);
    await applyChecked(model, deps(fake, s));
    expect(await bodyOf(fake, 'o')).toBe(`${FM}# O\n\n[[Nota nueva#Sección|texto]] y ![[Nota nueva]] y [[Nota nueva#^bloque]]\n`);
    await fake.dispose();
  });
});

describe('12. una escritura y una versión por nota', () => {
  it('un enlace y la descripción en la misma nota: una entrada, una llamada, una revisión nueva', async () => {
    const fake = makeFake({ o: '# O\n\nTexto con [[Cancion]] dentro.\n', c: `${FM}# Canción\n` });
    const s = spy(fake);
    const model = await prepare(fake);
    const descriptions = sectionOf(model, 'descriptions').rows;
    const mine = descriptions.find((r) => r.id === 'o')!;
    setChecked(model, mine.id, true);
    const before = await revisionOf(fake, 'o');
    const report = await applyChecked(model, deps(fake, s));
    expect(s.batches).toHaveLength(1);
    expect(s.batches[0].ids).toEqual(['o']);
    expect(s.batches[0].strict).toEqual([true]);
    expect(s.batches[0].options).toEqual({ cause: 'Mantenimiento: 1 enlace y descripción', touchUpdatedAt: false });
    expect((await revisionOf(fake, 'o')).localSeq).toBe(before.localSeq + 1);
    expect(report).toMatchObject({ changes: 2, notes: 1, batches: 1 });
    const body = await bodyOf(fake, 'o');
    expect(body).toContain('[[Canción]]');
    expect(markdownOf(fake).frontmatter(body)?.descripcion).toBe('Texto con Cancion dentro.'); // la propuesta sale del cuerpo de la revisión
    expect(s.saves).toBe(0);
    await fake.dispose();
  });

  it('la causa resume lo que cambia', () => {
    expect(causeOf(2, true)).toBe('Mantenimiento: 2 enlaces y descripción');
    expect(causeOf(1, false)).toBe('Mantenimiento: 1 enlace');
    expect(causeOf(0, true)).toBe('Mantenimiento: descripción');
  });
});

describe('15. la descripción con : y comillas se relee exacta', () => {
  it.each([
    ['con dos puntos', 'Resumen: lo que importa, ahora.'],
    ['con comillas', 'Dice "hola" y \'adiós\' a todos.'],
    ['con ambas y almohadilla', 'Plan: "fase #1" — sí: o no.']
  ])('%s', async (_name, paragraph) => {
    const fake = makeFake({ n: `# N\n\n${paragraph}\n` });
    const s = spy(fake);
    const model = await prepare(fake);
    const row = sectionOf(model, 'descriptions').rows[0];
    if (row.kind !== 'description') throw new Error('fila inesperada');
    setChecked(model, row.id, true);
    await applyChecked(model, deps(fake, s));
    const body = await bodyOf(fake, 'n');
    expect(markdownOf(fake).frontmatter(body)?.descripcion).toBe(row.item.proposal);
    expect(row.item.proposal).toBe(paragraph);
    expect(body.endsWith('# N\n\n' + paragraph + '\n')).toBe(true);
    await fake.dispose();
  });

  it('si setProperty devuelve el cuerpo tal cual, la fila dice que no hay forma segura y no se escribe', async () => {
    const fake = makeFake({ n: '# N\n\nUn párrafo.\n' });
    const s = spy(fake);
    const model = await prepare(fake);
    const row = sectionOf(model, 'descriptions').rows[0];
    setChecked(model, row.id, true);
    const markdown: ApplyMarkdown = { ...markdownOf(fake), setProperty: (body) => body };
    const report = await applyChecked(model, deps(fake, s, markdown));
    expect(s.batches).toHaveLength(0);
    expect(row.kind === 'description' && row.outcome?.text).toBe(REASON_TEXT.unsafe);
    expect(report.notes).toBe(0);
    await fake.dispose();
  });

  it('si el cuerpo nuevo no relee la descripción exacta, tampoco se escribe', async () => {
    const fake = makeFake({ n: '# N\n\nUn párrafo.\n' });
    const s = spy(fake);
    const model = await prepare(fake);
    const row = sectionOf(model, 'descriptions').rows[0];
    setChecked(model, row.id, true);
    const markdown: ApplyMarkdown = { ...markdownOf(fake), setProperty: (body) => `---\ndescripcion: roto\n---\n${body}` };
    await applyChecked(model, deps(fake, s, markdown));
    expect(s.batches).toHaveLength(0);
    expect(row.kind === 'description' && row.outcome?.text).toBe(REASON_TEXT.unsafe);
    await fake.dispose();
  });
});

describe('9. protegidas', () => {
  const library = (): Record<string, FakeSeedNote> => ({
    a: `${FM}# A\n\n[[Cancion]]\n`,
    b: `${FM}# B\n\n[[Cancion]]\n`,
    c: `${FM}# C\n\n[[Cancion]]\n`,
    can: `${FM}# Canción\n`
  });

  it('protegida entre la revisión y Aplicar: su fila acaba en «Protegida: no se tocó» y el resto se escribe', async () => {
    const fake = makeFake(library());
    const s = spy(fake);
    const model = await prepare(fake);
    s.locked.add('b');
    const report = await applyChecked(model, deps(fake, s));
    const byNote = (id: string): LinkRow => linkRows(model).find((r) => r.finding.sourceId === id)!;
    expect(byNote('b').outcome).toEqual({ state: 'failed', text: 'Protegida: no se tocó' });
    expect(byNote('a').outcome?.state).toBe('done');
    expect(byNote('c').outcome?.state).toBe('done');
    expect(s.batches.flatMap((b) => b.ids).sort()).toEqual(['a', 'c']);
    expect(await bodyOf(fake, 'b')).toContain('[[Cancion]]');
    expect(report).toMatchObject({ notes: 2, failedRows: 1 });
    await fake.dispose();
  });

  it('se protege entre la lectura y la escritura: note-locked tumba el lote, se piden resúmenes, se quitan y se reintenta UNA vez', async () => {
    const fake = makeFake(library());
    const s = spy(fake);
    const model = await prepare(fake);
    s.afterRead = (id) => {
      if (id === 'b') s.locked.add('b');
    };
    // La lectura de «b» ya devolvió el cuerpo; la escritura la encontrará protegida.
    const report = await applyChecked(model, deps(fake, s));
    expect(s.batches).toHaveLength(2);
    expect(s.batches[0].ids.sort()).toEqual(['a', 'b', 'c']);
    expect(s.batches[1].ids.sort()).toEqual(['a', 'c']);
    const byNote = (id: string): LinkRow => linkRows(model).find((r) => r.finding.sourceId === id)!;
    expect(byNote('b').outcome?.text).toBe('Protegida: no se tocó');
    expect(byNote('a').outcome?.state).toBe('done');
    expect(byNote('c').outcome?.state).toBe('done');
    expect(report.notes).toBe(2);
    expect(s.saves).toBe(0);
    await fake.dispose();
  });

  it('si el reintento vuelve a fallar no hay un tercer intento', async () => {
    const fake = makeFake(library());
    const s = spy(fake);
    const model = await prepare(fake);
    let calls = 0;
    const real = s.vault.notesRewriteBatch;
    s.vault.notesRewriteBatch = (entries, options) => {
      calls += 1;
      if (calls === 2) return Promise.reject(Object.assign(new Error('otra vez'), { code: 'note-locked' }));
      s.locked.add('b');
      return real(entries, options);
    };
    await applyChecked(model, deps(fake, s));
    expect(calls).toBe(2);
    await fake.dispose();
  });

  it('una nota que ya no existe acaba en «Ya no existe»', async () => {
    const fake = makeFake(library());
    const s = spy(fake);
    const model = await prepare(fake);
    s.gone.add('a');
    await applyChecked(model, deps(fake, s));
    expect(linkRows(model).find((r) => r.finding.sourceId === 'a')!.outcome?.text).toBe('Ya no existe');
    await fake.dispose();
  });
});

describe('10. cambiada entre la revisión y Aplicar', () => {
  it('no se escribe, no hay copia de conflicto y la fila lo dice', async () => {
    const fake = makeFake({ o: `${FM}# O\n\n[[Cancion]]\n`, c: `${FM}# Canción\n`, p: `${FM}# P\n\n[[Cancion]]\n` });
    const s = spy(fake);
    const model = await prepare(fake);
    const notesBefore = (await scanOf(fake)).notes.length;
    fake.host.touchNote('o', `${FM}# O\n\n[[Cancion]] y algo nuevo\n`);
    const report = await applyChecked(model, deps(fake, s));
    const row = linkRows(model).find((r) => r.finding.sourceId === 'o')!;
    expect(row.outcome).toEqual({ state: 'failed', text: 'Cambió desde la revisión: no se tocó' });
    expect(await bodyOf(fake, 'o')).toBe(`${FM}# O\n\n[[Cancion]] y algo nuevo\n`);
    expect((await scanOf(fake)).notes).toHaveLength(notesBefore);
    expect(report).toMatchObject({ changedMeanwhile: 1, notes: 1 });
    expect(appliedSummary(report)).toBe('Aplicado 1 cambio en 1 nota. 1 nota cambió mientras tanto y no se tocó.');
    expect(s.saves).toBe(0);
    await fake.dispose();
  });

  it('cambia entre la lectura y la escritura: strictRevision la devuelve en stale, sin copia de conflicto', async () => {
    const fake = makeFake({ o: `${FM}# O\n\n[[Cancion]]\n`, c: `${FM}# Canción\n` });
    const s = spy(fake);
    const model = await prepare(fake);
    const notesBefore = (await scanOf(fake)).notes.length;
    s.afterRead = (id) => {
      if (id === 'o') fake.host.touchNote('o', `${FM}# O\n\n[[Cancion]] editada\n`);
    };
    const report = await applyChecked(model, deps(fake, s));
    expect(linkRows(model)[0].outcome?.text).toBe('Cambió desde la revisión: no se tocó');
    expect(report.changedMeanwhile).toBe(1);
    expect((await scanOf(fake)).notes).toHaveLength(notesBefore);
    await fake.dispose();
  });

  it('los resúmenes concuerdan en plural', () => {
    const outcomes = new Map([
      ['a', { state: 'failed' as const, text: 'Cambió desde la revisión: no se tocó' }],
      ['b', { state: 'failed' as const, text: 'Cambió desde la revisión: no se tocó' }],
      ['c', { state: 'failed' as const, text: 'Protegida: no se tocó' }]
    ]);
    expect(appliedSummary({ outcomes, changes: 14, notes: 11, changedMeanwhile: 2, failedRows: 3, batches: 1 })).toBe(
      'Aplicados 14 cambios en 11 notas. 2 notas cambiaron mientras tanto y no se tocaron. 1 cambio no se aplicó: mira el motivo en cada fila.'
    );
  });
});

describe('lotes de 200', () => {
  it('450 notas son 3 llamadas (200, 200, 50), con la misma causa', async () => {
    const notes: Record<string, FakeSeedNote> = { can: `${FM}# Canción\n` };
    for (let i = 0; i < 450; i += 1) notes[`n-${String(i).padStart(3, '0')}`] = `${FM}# N ${i}\n\n[[Cancion]]\n`;
    const fake = makeFake(notes);
    const s = spy(fake);
    const model = await prepare(fake);
    expect(linkRows(model).filter((r) => r.checked)).toHaveLength(450);
    const report = await applyChecked(model, deps(fake, s));
    expect(s.batches.map((b) => b.ids.length)).toEqual([200, 200, 50]);
    expect(s.batches.every((b) => (b.options as { cause: string }).cause === 'Mantenimiento: 1 enlace')).toBe(true);
    expect(report).toMatchObject({ notes: 450, changes: 450, batches: 3 });
    expect(s.saves).toBe(0);
    await fake.dispose();
  });

  it('causas distintas van en llamadas distintas (la causa es una por llamada)', async () => {
    const fake = makeFake({
      a: `${FM}# A\n\n[[Cancion]]\n`,
      b: `${FM}# B\n\n[[Cancion]] y [[Cancion#x]] [[Cancion]]\n`,
      can: `${FM}# Canción\n`
    });
    const s = spy(fake);
    const model = await prepare(fake);
    await applyChecked(model, deps(fake, s));
    expect(s.batches.map((b) => (b.options as { cause: string }).cause).sort()).toEqual(['Mantenimiento: 1 enlace', 'Mantenimiento: 3 enlaces']);
    await fake.dispose();
  });
});

describe('escrituras propias', () => {
  it('un evento solo es propio si todos sus ids lo son y dentro de la ventana', () => {
    let t = 1000;
    const own = createOwnWrites(() => t, 2000);
    expect(own.isOwn(['a'])).toBe(false);
    own.begin(['a', 'b']);
    expect(own.isOwn(['a'])).toBe(true);
    expect(own.isOwn(['a', 'z'])).toBe(false);
    own.end(['a', 'b']);
    t = 2500;
    expect(own.isOwn(['a', 'b'])).toBe(true);
    t = 3500;
    expect(own.isOwn(['a'])).toBe(false);
    expect(own.isOwn([])).toBe(false);
  });
});
