// @vitest-environment happy-dom
//
// Criterios de aceptación 1 a 8, 13 y 14 de docs/SPEC.md contra el host falso v2.
import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { detectLinks, keyOf, planFix, buildLinkIndex, resolveLink, rewriteLinks, type LinkFinding, type LinkFix } from '../src/detect/links';
import { jdPrefixOf } from '../src/detect/jd';
import { openDb } from '../src/scan/db';
import { renameRegistry } from '../src/scan/renames';
import type { ScanResult } from '../src/scan/types';
import { makeFake, scanOf } from './helpers';

type Fake = ReturnType<typeof makeFake>;

/** Detecta y, con `rename`, usa un registro de renombrados real (IndexedDB falsa). */
async function findings(fake: Fake, rename?: [string, string][]): Promise<{ scan: ScanResult; list: LinkFinding[] }> {
  const scan = await scanOf(fake);
  let lookup: ((t: string) => Promise<string | null>) | undefined;
  if (rename) {
    const db = await openDb({ indexedDB: new IDBFactory(), name: 'x' });
    const registry = renameRegistry(db);
    for (const [oldTitle, id] of rename) await registry.record(oldTitle, id);
    lookup = (t) => registry.lookup(t);
  }
  return { scan, list: await detectLinks(scan, lookup) };
}

/** Aplica los arreglos marcados del hallazgo sobre el cuerpo real de la nota. */
function applyChecked(fake: Fake, list: LinkFinding[], noteId: string, body: string): string {
  const fixes: LinkFix[] = list
    .filter((f) => f.sourceId === noteId && f.checked && f.fix)
    .map((f) => ({ key: f.key, newTarget: f.fix!.newTarget, addAlias: f.fix!.addAlias }));
  return rewriteLinks(body, fake.api.markdown.links(body), fixes).body;
}

describe('1. renombrado en este dispositivo', () => {
  it('[[Plan viejo]] sale marcado y al aplicar queda [[Plan 2027]] y nada más cambia', async () => {
    const body = 'Antes\n\nVer [[Plan viejo]] y [[Plan viejo]] otra vez.\n\nFin\n';
    const fake = makeFake({ origen: { body: `# Origen\n\n${body}` }, 'n-plan': '# Plan 2027\n' });
    const { list } = await findings(fake, [['  Plan VIEJO ', 'n-plan']]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'broken', checked: true, occurrences: 2 });
    expect(list[0].candidates.map((c) => [c.note.id, c.reasons])).toEqual([['n-plan', ['R1']]]);
    const source = `# Origen\n\n${body}`;
    expect(applyChecked(fake, list, 'origen', source)).toBe(source.split('[[Plan viejo]]').join('[[Plan 2027]]'));
    await fake.dispose();
  });
});

describe('2. sin acentos', () => {
  it('[[Cancion]] con una sola «Canción» sale marcado', async () => {
    const fake = makeFake({ o: '# O\n\n[[Cancion]]\n', c: '# Canción\n' });
    const { list } = await findings(fake);
    expect(list[0]).toMatchObject({ status: 'broken', checked: true });
    expect(list[0].candidates[0].reasons).toEqual(['R2']);
    expect(list[0].fix?.newTarget).toBe('Canción');
    await fake.dispose();
  });

  it('con «Canción» en dos carpetas sale sin marcar con los dos; al elegir se escribe [[Carpeta/Canción|Cancion]] y resuelve a una', async () => {
    const fake = makeFake({ o: '# O\n\n[[Cancion]]\n' });
    const a = await fake.api.vault.folderCreate(null, 'Carpeta');
    const b = await fake.api.vault.folderCreate(null, 'Otra');
    const na = await fake.api.vault.noteCreate({ folderId: a.id, body: '# Canción\n' });
    const nb = await fake.api.vault.noteCreate({ folderId: b.id, body: '# Canción\n' });
    const { scan, list } = await findings(fake);
    expect(list).toHaveLength(1);
    expect(list[0].checked).toBe(false);
    expect(list[0].candidates.map((c) => c.folderPath).sort()).toEqual(['Carpeta', 'Otra']);

    const index = buildLinkIndex(scan);
    const plan = planFix(index, scan.notes.find((n) => n.id === na.id)!);
    expect(plan).toEqual({ newTarget: 'Carpeta/Canción', addAlias: true, resolvesToOnlyTarget: true });
    const body = '# O\n\n[[Cancion]]\n';
    const fixed = rewriteLinks(body, fake.api.markdown.links(body), [{ key: list[0].key, ...plan! }]).body;
    expect(fixed).toBe('# O\n\n[[Carpeta/Canción|Cancion]]\n');
    // El enlace reescrito resuelve a una sola nota: la elegida.
    const [again] = fake.api.markdown.links(fixed);
    const resolution = resolveLink(index, again);
    expect(resolution.status).toBe('ok');
    expect(resolution.candidates.map((n) => n.id)).toEqual([na.id]);
    void nb;
    await fake.dispose();
  });
});

describe('3. número JD', () => {
  it('[[11.01 Viajes]] sin destino y una nota «11.05 Viajes» sale SIN marcar, con ella de candidata', async () => {
    const fake = makeFake({ o: '# O\n\n[[11.01 Viajes]]\n', v: '# 11.05 Viajes\n' });
    const { list } = await findings(fake);
    expect(list[0].candidates.map((c) => [c.note.id, c.changesJdNumber])).toEqual([['v', true]]);
    expect(list[0].checked).toBe(false);
    await fake.dispose();
  });

  it('no sobre-bloquea: [[Viajes]] y «11.01 Viajes» (R3) sale marcado, y [[11.01 viajes!]] -> «11.01 Viajes» (R2, mismo número) también', async () => {
    const fake = makeFake({ o: '# O\n\n[[Viajes]]\n\n[[11.01 viajes!]]\n', v: '# 11.01 Viajes\n' });
    const { list } = await findings(fake);
    expect(list).toHaveLength(2);
    expect(list.every((f) => f.checked)).toBe(true);
    expect(list.find((f) => f.link.target === 'viajes')?.candidates[0].reasons).toEqual(['R3']);
    await fake.dispose();
  });

  it('el prefijo JD se reconoce como en JDex Manager', () => {
    for (const ok of ['10-19 A', '11 A', '11.01 A', '11.01+ A', 'D01.11.01 A']) expect(jdPrefixOf(ok), ok).not.toBeNull();
    for (const no of ['20-39 A', 'Viajes', '1.1 A', '111 A']) expect(jdPrefixOf(no), no).toBeNull();
    expect(jdPrefixOf('11.01 Viajes')).toEqual({ number: '11.01', title: 'Viajes' });
  });
});

describe('4. se conserva todo menos el destino', () => {
  it('[[Nota vieja#Sección|texto]] y ![[Nota vieja]] conservan #Sección, alias y !', async () => {
    const body = '# O\n\n[[Nota vieja#Sección|texto]] y ![[Nota vieja]] y [[Nota vieja#^bloque]]\n';
    const fake = makeFake({ o: body, n: '# Nota nueva\n' });
    const { list } = await findings(fake, [['nota vieja', 'n']]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ checked: true, occurrences: 3 });
    expect(applyChecked(fake, list, 'o', body)).toBe(
      '# O\n\n[[Nota nueva#Sección|texto]] y ![[Nota nueva]] y [[Nota nueva#^bloque]]\n'
    );
    await fake.dispose();
  });

  it('con aliasSeparator \\| el alias se separa como en una celda de tabla', () => {
    const body = '| [[Cancion]] |\n';
    const links = [
      {
        kind: 'wikilink', from: 2, to: 13, targetFrom: 4, targetTo: 11, rawTarget: 'Cancion', target: 'cancion',
        targetPath: null, alias: null, heading: null, blockId: null, targetKind: 'note-title'
      }
    ] as const;
    const out = rewriteLinks(body, links, [{ key: keyOf({ ...links[0], target: 'cancion' }), newTarget: 'A/Canción', addAlias: true }], { aliasSeparator: '\\|' });
    expect(out.body).toBe('| [[A/Canción\\|Cancion]] |\n');
  });
});

describe('5. a una nota que existe no se le dice nada', () => {
  it('aunque el encabezado no exista, por título, por ruta y por id', async () => {
    const fake = makeFake({ o: '# O\n\n[[Destino#No existe]] [[Destino]] [[id:d]] [[Destino.md]]\n', d: '# Destino\n' });
    const { list } = await findings(fake);
    expect(list).toEqual([]);
    await fake.dispose();
  });

  it('[[id:...]] sin nota con ese id sale roto y sin candidatos', async () => {
    const fake = makeFake({ o: '# O\n\n[[id:fantasma]]\n' });
    const { list } = await findings(fake);
    expect(list[0]).toMatchObject({ status: 'broken', checked: false, candidates: [] });
    await fake.dispose();
  });
});

describe('6 y 7. lo que no es un enlace o no se juzga', () => {
  it('bloque de código, código en línea, frontmatter, HTML y %%…%% no salen', async () => {
    const body = [
      '---',
      'ref: "[[Nota inexistente]]"',
      '---',
      '# O',
      '',
      '```',
      '[[Nota inexistente]]',
      '```',
      '',
      '`[[Nota inexistente]]`',
      '',
      '<span title="[[Nota inexistente]]">x</span>',
      '',
      '%%[[Nota inexistente]]%%',
      ''
    ].join('\n');
    const fake = makeFake({ o: body });
    const { list } = await findings(fake);
    expect(list).toEqual([]);
    await fake.dispose();
  });

  it('[[#Encabezado]], [[task:…]], [[list:…]], [[{{today}}]], [texto](Nota.md), ficheros y hashes no salen', async () => {
    const body = '# O\n\n[[#Encabezado]] [[task:abc]] [[list:xyz]] [[{{today}}]] [texto](Nota.md) [[plano.pdf]] ![[foto.png]] [[]]\n';
    const fake = makeFake({ o: body });
    const { list } = await findings(fake);
    expect(list).toEqual([]);
    await fake.dispose();
  });

  it('un título de más de 200 caracteres no se juzga', async () => {
    const fake = makeFake({ o: `# O\n\n[[${'a'.repeat(201)}]]\n` });
    const { list } = await findings(fake);
    expect(list).toEqual([]);
    await fake.dispose();
  });
});

describe('8. archivadas', () => {
  it('un enlace a una nota archivada no sale como roto', async () => {
    const fake = makeFake({ o: '# O\n\n[[Vieja]]\n', a: { body: '# Vieja\n', archivedAt: 5 } });
    const { list } = await findings(fake);
    expect(list).toEqual([]);
    await fake.dispose();
  });
});

describe('13 y 14. copias de conflicto', () => {
  it('una copia de conflicto, única candidata, no va marcada', async () => {
    const fake = makeFake({ o: '# O\n\n[[Cancion]]\n', c: { body: '# Canción\n', conflictOf: 'x' } });
    const { list } = await findings(fake);
    expect(list[0]).toMatchObject({ status: 'broken', checked: false });
    expect(list[0].candidates[0].conflictCopy).toBe(true);
    await fake.dispose();
  });

  it('un [[Título]] cuyo destino tiene copia sale ambiguo, con la copia etiquetada', async () => {
    const fake = makeFake({
      o: '# O\n\n[[Título]]\n',
      t: '# Título\n',
      't-copia': { body: '# Título\n', conflictOf: 't' }
    });
    const { list } = await findings(fake);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'ambiguous', checked: false });
    expect(list[0].candidates.map((c) => [c.note.id, c.conflictCopy]).sort()).toEqual([
      ['t', false],
      ['t-copia', true]
    ]);
    await fake.dispose();
  });
});

describe('ruta como desempate y títulos que no se pueden escribir', () => {
  it('[[B/Canción]] con dos «Canción» resuelve por ruta y no sale', async () => {
    const fake = makeFake({ o: '# O\n\n[[B/Canción]]\n' });
    const a = await fake.api.vault.folderCreate(null, 'A');
    const b = await fake.api.vault.folderCreate(null, 'B');
    await fake.api.vault.noteCreate({ folderId: a.id, body: '# Canción\n' });
    await fake.api.vault.noteCreate({ folderId: b.id, body: '# Canción\n' });
    const { list } = await findings(fake);
    expect(list).toEqual([]);
    await fake.dispose();
  });

  it('un título con `|` o `#` no se ofrece como arreglo marcado', async () => {
    const fake = makeFake({ o: '# O\n\n[[Plan]]\n', p: { body: '---\ntitle: "Plan #2"\n---\n' } });
    const { list } = await findings(fake, [['plan', 'p']]);
    expect(list[0].checked).toBe(false);
    expect(list[0].fix).toBeNull();
    await fake.dispose();
  });

  it('las protegidas no aportan enlaces', async () => {
    const fake = makeFake({ o: '# O\n\n[[Nada]]\n' });
    const scan = await scanOf(fake);
    const locked = { ...scan, notes: scan.notes.map((n) => ({ ...n, locked: true, analysis: null })) };
    expect(await detectLinks(locked)).toEqual([]);
    await fake.dispose();
  });
});
