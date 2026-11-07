// @vitest-environment happy-dom
//
// Revisión independiente de P6 (B1 a B3, M1 a M7, N1 a N3). Los casos que dependen de cómo parsea
// Hebra de verdad usan las funciones REALES de `api.markdown` (`npm run build:real-markdown`
// genera `.real/frame-markdown.mjs`); sin ese fichero se saltan. El resto va con el host falso.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';
import { pathToFileURL } from 'node:url';
import type { PluginMarkdown } from 'hebra-plugin-api/v2';
import { describe, expect, it } from 'vitest';
import { applyChecked, REASON_TEXT, type ApplyMarkdown } from '../src/apply/apply';
import { detectLinks, rewriteLinks } from '../src/detect/links';
import { proposeDescription } from '../src/detect/proposal';
import { analyze, buildModel, chooseCandidate, sectionOf, setChecked, type DescriptionRow, type LinkRow, type ResultsModel } from '../src/results/model';
import { scanLibrary } from '../src/scan/scan';
import type { ScanMarkdown } from '../src/scan/types';
// @ts-expect-error -- plain .mjs without types
import { findForbiddenCalls } from '../scripts/forbidden-calls.mjs';
import { deps, makeFake, markdownOf, mountWith, spy, type Fake } from './helpers';

const REAL = join(cwd(), '.real', 'frame-markdown.mjs');
const real: PluginMarkdown | null = existsSync(REAL)
  ? ((await import(/* @vite-ignore */ pathToFileURL(REAL).href)) as { FRAME_MARKDOWN: PluginMarkdown }).FRAME_MARKDOWN
  : null;
const FM = '---\ndescripcion: x\n---\n';

async function modelWith(fake: Fake, markdown: ScanMarkdown): Promise<ResultsModel> {
  const scan = await scanLibrary({ vault: fake.api.vault, markdown, cache: null }, { pause: () => Promise.resolve() });
  return buildModel(await analyze(scan));
}
const linkRows = (m: ResultsModel): LinkRow[] => sectionOf(m, 'links').rows as LinkRow[];
const descRows = (m: ResultsModel): DescriptionRow[] => sectionOf(m, 'descriptions').rows as DescriptionRow[];
const bodyOf = async (fake: Fake, id: string): Promise<string> => (await fake.api.vault.noteRead(id))!.body!;

describe.skipIf(real === null)('B1. una descripcion que no es texto no se pisa (Hebra real)', () => {
  const md = real as PluginMarkdown;
  it.each([
    ['un mapa', '---\ndescripcion:\n  es: Texto\n---\nPárrafo.\n'],
    ['un número', '---\ndescripcion: 2024\n---\nPárrafo.\n'],
    ['un booleano', '---\ndescripcion: true\n---\nPárrafo.\n']
  ])('%s: la nota no sale en «Sin descripción» y no se toca', async (_n, body) => {
    const fake = makeFake({ n: body });
    const model = await modelWith(fake, md);
    expect(descRows(model).map((r) => r.id)).not.toContain('n');
    expect(await bodyOf(fake, 'n')).toBe(body);
    await fake.dispose();
  });

  it.each([
    ['vacía entre comillas', '---\ndescripcion: ""\n---\nPárrafo.\n'],
    ['sin valor', '---\ndescripcion:\n---\nPárrafo.\n'],
    ['lista vacía', '---\ndescripcion: []\n---\nPárrafo.\n'],
    ['lista de cadenas vacías', '---\ndescripcion:\n  - ""\n---\nPárrafo.\n'],
    ['clave ausente', '---\ntitle: Hola\n---\nPárrafo.\n']
  ])('%s: sí cuenta como sin descripción y se escribe', async (_n, body) => {
    const fake = makeFake({ n: body });
    const model = await modelWith(fake, md);
    const row = descRows(model).find((r) => r.id === 'n');
    expect(row?.item.proposal).toBe('Párrafo.');
    setChecked(model, 'n', true);
    await applyChecked(model, deps(fake, spy(fake), md));
    expect(md.frontmatter(await bodyOf(fake, 'n'))?.descripcion).toBe('Párrafo.');
    await fake.dispose();
  });

  it('red de seguridad: si setProperty pierde otra clave del frontmatter, la fila acaba como no segura', async () => {
    const fake = makeFake({ n: '---\ntitle: Hola\ntags: [a, b]\n---\nPárrafo.\n' });
    const model = await modelWith(fake, markdownOf(fake));
    setChecked(model, 'n', true);
    const lossy: ApplyMarkdown = {
      ...markdownOf(fake),
      setProperty: (_body, key, value) => `---\n${key}: ${JSON.stringify(value)}\n---\nPárrafo.\n`
    };
    const s = spy(fake);
    await applyChecked(model, deps(fake, s, lossy));
    expect(descRows(model)[0].outcome?.text).toBe(REASON_TEXT.unsafe);
    expect(s.batches).toHaveLength(0);
    await fake.dispose();
  });

  it('red de seguridad: si setProperty cambia el cuerpo tras el frontmatter, tampoco se escribe', async () => {
    const fake = makeFake({ n: '---\ntitle: Hola\n---\nPárrafo.\n' });
    const model = await modelWith(fake, markdownOf(fake));
    setChecked(model, 'n', true);
    const lossy: ApplyMarkdown = {
      ...markdownOf(fake),
      setProperty: (body, key, value) => markdownOf(fake).setProperty(body, key, value).replace(/\nPárrafo\.\n$/, '\nOtro.\n')
    };
    await applyChecked(model, deps(fake, spy(fake), lossy));
    expect(descRows(model)[0].outcome?.text).toBe(REASON_TEXT.unsafe);
    await fake.dispose();
  });
});

describe.skipIf(real === null)('B2. el separador del alias sale de cómo lee Hebra el cuerpo (Hebra real)', () => {
  const md = real as PluginMarkdown;
  async function applyTo(source: string): Promise<{ body: string; fake: Fake; model: ResultsModel }> {
    const fake = makeFake({ o: `${FM}${source}` });
    const a = await fake.api.vault.folderCreate(null, 'Música');
    const b = await fake.api.vault.folderCreate(null, 'Otra');
    const na = await fake.api.vault.noteCreate({ folderId: a.id, body: `${FM}# Canción\n` });
    await fake.api.vault.noteCreate({ folderId: b.id, body: `${FM}# Canción\n` });
    const model = await modelWith(fake, md);
    chooseCandidate(model, linkRows(model)[0].id, na.id);
    await applyChecked(model, deps(fake, spy(fake), md));
    return { body: await bodyOf(fake, 'o'), fake, model };
  }
  const reparse = (body: string) => md.links(body).map((l) => [l.target, l.targetPath, l.alias]);

  it('tabla sin barra inicial: el alias lleva \\| y el enlace sigue entero', async () => {
    const { body, fake } = await applyTo('col | b\n--- | ---\n[[Cancion]] | z\n');
    expect(reparse(body)).toEqual([['canción', 'música', 'Cancion']]);
    expect(body).toContain('[[Música/Canción\\|Cancion]]');
    await fake.dispose();
  });

  it('una línea que empieza por | pero no es tabla: el alias lleva | sin escapar', async () => {
    const { body, fake } = await applyTo('| esto no es tabla [[Cancion]]\n');
    expect(reparse(body)).toEqual([['canción', 'música', 'Cancion']]);
    expect(body).toContain('[[Música/Canción|Cancion]]');
    await fake.dispose();
  });

  it('tabla con sangría, en cita y en lista', async () => {
    for (const source of [
      '| a | b |\n| --- | --- |\n  | [[Cancion]] | z |\n',
      '> | a | b |\n> | --- | --- |\n> | [[Cancion]] | z |\n',
      '- | a | b |\n  | --- | --- |\n  | [[Cancion]] | z |\n'
    ]) {
      const { body, fake } = await applyTo(source);
      expect(reparse(body), source).toEqual([['canción', 'música', 'Cancion']]);
      await fake.dispose();
    }
  });
});

describe('B2 y B3. el cuerpo nuevo se verifica con markdown.links antes de escribir', () => {
  it('si los enlaces no cuadran tras reescribir, no se escribe y la fila lo dice', async () => {
    const fake = makeFake({ o: `${FM}# O\n\n[[Cancion]]\n`, c: `${FM}# Canción\n` });
    const base = markdownOf(fake);
    const model = await modelWith(fake, base);
    expect(linkRows(model)[0].checked).toBe(true);
    // Un `links` que, sobre el cuerpo ya reescrito, pierde el enlace.
    const lying: ApplyMarkdown = { ...base, links: (body) => (body.includes('[[Canción]]') ? [] : base.links(body)) };
    const s = spy(fake);
    await applyChecked(model, deps(fake, s, lying));
    expect(linkRows(model)[0].outcome).toEqual({ state: 'failed', text: 'No se pudo verificar el cambio: no se tocó' });
    expect(s.batches).toHaveLength(0);
    expect(await bodyOf(fake, 'o')).toBe(`${FM}# O\n\n[[Cancion]]\n`);
    await fake.dispose();
  });

  it('B3: un título con %% no se ofrece como arreglo marcado', async () => {
    const fake = makeFake({ o: `${FM}# O\n\n[[50 de descuento]] y luego [[Otra]]\n`, d: `${FM}# 50%% de descuento\n`, x: `${FM}# Otra\n` });
    const model = await modelWith(fake, markdownOf(fake));
    const row = linkRows(model).find((r) => r.finding.link.target === '50 de descuento')!;
    expect(row.finding.candidates).toHaveLength(1);
    expect(row.finding.fix).toBeNull();
    expect(row.checked).toBe(false);
    await fake.dispose();
  });
});

describe('M1. un enlace en el H1 que da el título no se reescribe', () => {
  it('la fila dice por qué y el cuerpo queda igual', async () => {
    const source = '# Reunión con [[Cancion]]\n\nTexto\n';
    const fake = makeFake({ o: source, c: `${FM}# Canción\n` });
    const model = await modelWith(fake, markdownOf(fake));
    const row = linkRows(model)[0];
    expect(row.checked).toBe(true);
    await applyChecked(model, deps(fake, spy(fake)));
    expect(row.outcome?.text).toBe(REASON_TEXT.title);
    expect(await bodyOf(fake, 'o')).toBe(source);
    await fake.dispose();
  });

  it('con title: en el frontmatter el H1 no da el título y sí se reescribe', async () => {
    const source = '---\ntitle: Fijo\n---\n# Reunión con [[Cancion]]\n';
    const fake = makeFake({ o: source, c: `${FM}# Canción\n` });
    const model = await modelWith(fake, markdownOf(fake));
    await applyChecked(model, deps(fake, spy(fake)));
    expect(linkRows(model)[0].outcome?.state).toBe('done');
    await fake.dispose();
  });
});

describe('M4 y M5. fallos del reintento y notas en la papelera', () => {
  it('M5: una nota en la papelera cuenta como «Ya no existe»', async () => {
    const fake = makeFake({ o: `${FM}# O\n\n[[Cancion]]\n`, c: `${FM}# Canción\n` });
    const model = await modelWith(fake, markdownOf(fake));
    const s = spy(fake);
    const read = s.vault.noteRead;
    s.vault.noteRead = async (id) => {
      const note = await read(id);
      return note && id === 'o' ? { ...note, trashedAt: 5 } : note;
    };
    await applyChecked(model, deps(fake, s));
    expect(linkRows(model)[0].outcome?.text).toBe('Ya no existe');
    expect(s.batches).toHaveLength(0);
    await fake.dispose();
  });

  it('M4: si noteSummary lanza en el reintento, ese lote queda como error y lo ya escrito se registra', async () => {
    const fake = makeFake({
      a: `${FM}# A\n\n[[Cancion]]\n`,
      b: `${FM}# B\n\n[[Cancion]] [[Cancion]] [[Cancion]]\n`,
      c: `${FM}# Canción\n`
    });
    const model = await modelWith(fake, markdownOf(fake));
    const s = spy(fake);
    s.afterRead = (id) => {
      if (id === 'b') s.locked.add('b');
    };
    const summary = s.vault.noteSummary;
    s.vault.noteSummary = (ids) => (ids.includes('b') ? Promise.reject(new Error('sin red')) : summary(ids));
    const report = await applyChecked(model, deps(fake, s));
    const byNote = (id: string): LinkRow => linkRows(model).find((r) => r.finding.sourceId === id)!;
    expect(byNote('a').outcome?.state).toBe('done');
    expect(byNote('b').outcome?.text).toBe('No se pudo escribir: sin red');
    expect(report.notes).toBe(1);
    await fake.dispose();
  });
});

describe('M3. los segmentos de carpeta se comparan como Hebra: sin NFKC', () => {
  it('una carpeta en NFD y un enlace en NFC no son la misma ruta: queda ambiguo', async () => {
    const nfd = 'Música'.normalize('NFD');
    const fake = makeFake({ o: `${FM}# O\n\n[[Música/Canción]]\n` });
    const a = await fake.api.vault.folderCreate(null, nfd);
    const b = await fake.api.vault.folderCreate(null, 'Otra');
    await fake.api.vault.noteCreate({ folderId: a.id, body: `${FM}# Canción\n` });
    await fake.api.vault.noteCreate({ folderId: b.id, body: `${FM}# Canción\n` });
    const scan = await scanLibrary({ vault: fake.api.vault, markdown: markdownOf(fake), cache: null }, { pause: () => Promise.resolve() });
    const findings = await detectLinks(scan);
    expect(findings.map((f) => f.status)).toEqual(['ambiguous']);
    await fake.dispose();
  });
});

describe.skipIf(real === null)('M7. sin casilla si el frontmatter no se puede parchear (Hebra real)', () => {
  it('un cuerpo que empieza por --- sin frontmatter válido', async () => {
    const md = real as PluginMarkdown;
    const fake = makeFake({ n: '---\n\nTexto\n\n---\n' });
    const model = await modelWith(fake, md);
    const row = descRows(model).find((r) => r.id === 'n');
    if (row) {
      expect(row.item.writable).toBe(false);
      setChecked(model, 'n', true);
      expect(row.checked).toBe(false);
    }
    await fake.dispose();
  });
});

describe.skipIf(real === null)('M2. la propuesta usa frontmatterRange y salta lo que no es prosa (Hebra real)', () => {
  const md = real as PluginMarkdown;
  const propose = (body: string): string | null => proposeDescription(body, md.frontmatterRange(body));
  it.each([
    ['CRLF', '---\r\ntitle: Hola\r\n---\r\n\r\nPrimer párrafo.\r\n', 'Primer párrafo.'],
    ['BOM', '﻿---\ntitle: x\n---\nTexto con BOM', 'Texto con BOM'],
    ['cierre ...', '---\ntitle: x\n...\nTexto tras puntos', 'Texto tras puntos'],
    ['~~~', '~~~\ncode\n~~~\n\nTexto tras vallas', 'Texto tras vallas'],
    ['código sangrado', '    code indent\n\nTexto tras código', 'Texto tras código'],
    ['$$', '$$\nx^2\n$$\n\nTexto tras fórmula', 'Texto tras fórmula'],
    ['%% en bloque', '%%\nnota privada\n%%\n\nTexto tras comentario', 'Texto tras comentario'],
    ['%% en línea', 'Texto con %%oculto%% dentro', 'Texto con dentro'],
    ['imagen', 'Texto con ![img](a.png) y ![[x.png]] incrustado', 'Texto con y incrustado']
  ])('%s', (_n, body, expected) => {
    expect(propose(body)).toBe(expected);
  });
});

describe('M6. lo marcado por defecto que no se ha pintado se dice en el botón', () => {
  it('con 150 arreglos seguros y 100 filas pintadas: «(50 sin ver)»', async () => {
    const notes: Record<string, string> = { can: `${FM}# Canción\n` };
    for (let i = 0; i < 150; i += 1) notes[`n-${String(i).padStart(3, '0')}`] = `${FM}# N ${i}\n\n[[Cancion]]\n`;
    const fake = makeFake(notes);
    const model = await modelWith(fake, markdownOf(fake));
    const { el } = mountWith(model.review);
    expect(el.querySelector('.hebra-mantenimiento-apply')!.textContent).toBe('Aplicar 150 cambios en 150 notas (50 sin ver)');
    await fake.dispose();
  });
});

describe('N1 a N3', () => {
  it('N1: las variantes con guarda y fileReplace también están prohibidas', () => {
    for (const name of ['noteTrashIfUnchanged', 'noteMoveIfUnchanged', 'folderRenameIfUnchanged', 'fileReplace']) {
      expect(findForbiddenCalls(`api.vault.${name}(x)`), name).toEqual([name]);
    }
  });

  it('N2: un destino con paréntesis en una imagen Markdown no se propone', async () => {
    const fake = makeFake({ o: `${FM}# O\n\n![alt](Cancion 2027)\n`, c: `${FM}# Canción (2027)\n` });
    const scan = await scanLibrary({ vault: fake.api.vault, markdown: markdownOf(fake), cache: null }, { pause: () => Promise.resolve() });
    const [finding] = await detectLinks(scan);
    expect(finding.candidates).toHaveLength(1);
    expect(finding.fix).toBeNull();
    expect(finding.checked).toBe(false);
    await fake.dispose();
  });

  it('N3: el alias es el texto visible, sin ruta ni .md', () => {
    const fake = { markdown: null };
    void fake;
    const body = '[[Antigua/Cancion.md]]';
    const link = {
      kind: 'wikilink', from: 0, to: 22, targetFrom: 2, targetTo: 20, rawTarget: 'Antigua/Cancion.md', target: 'cancion',
      targetPath: 'antigua', alias: null, heading: null, blockId: null, targetKind: 'note-path'
    } as const;
    const out = rewriteLinks(body, [link], [{ key: { targetKind: 'note-path', target: 'cancion', targetPath: 'antigua' }, newTarget: 'Música/Canción', addAlias: true }]);
    expect(out.body).toBe('[[Música/Canción|Cancion]]');
  });
});

describe.skipIf(real === null)('Regresión de B2: notas SIN frontmatter con enlaces y descripción (Hebra real)', () => {
  const md = real as PluginMarkdown;
  it.each([
    ['criterio 15 sin frontmatter', 'Esto es *una* prueba con [[Enlace|alias]].\n', 'Esto es una prueba con alias.'],
    ['párrafo y enlace', 'Primer párrafo.\n\nVer [[Otra]].\n', 'Primer párrafo.'],
    ['con H1', '# Título\n\nPárrafo con [[Otra]].\n', 'Párrafo con Otra.'],
    ['CRLF', 'Párrafo [[Otra]].\r\n', 'Párrafo Otra.']
  ])('%s: se escribe y se relee', async (_n, source, proposal) => {
    const fake = makeFake({ n: source, otra: `${FM}# Otra\n`, enlace: `${FM}# Enlace\n` });
    const model = await modelWith(fake, md);
    const row = descRows(model).find((r) => r.id === 'n')!;
    expect(row.item.proposal).toBe(proposal);
    setChecked(model, 'n', true);
    const s = spy(fake);
    await applyChecked(model, deps(fake, s, md));
    expect(row.outcome).toEqual({ state: 'done', text: 'Hecho' });
    const body = await bodyOf(fake, 'n');
    expect(md.frontmatter(body)?.descripcion).toBe(proposal);
    expect(md.links(body).length).toBe(md.links(source).length);
    await fake.dispose();
  });

  it('la misma nota con un arreglo de enlace marcado además de la descripción', async () => {
    const source = 'Primer párrafo con [[Cancion]].\n';
    const fake = makeFake({ n: source, c: `${FM}# Canción\n` });
    const model = await modelWith(fake, md);
    expect(linkRows(model)[0].checked).toBe(true);
    setChecked(model, 'n', true);
    await applyChecked(model, deps(fake, spy(fake), md));
    expect(linkRows(model)[0].outcome?.state).toBe('done');
    expect(descRows(model)[0].outcome?.state).toBe('done');
    const body = await bodyOf(fake, 'n');
    expect(md.frontmatter(body)?.descripcion).toBe('Primer párrafo con Cancion.');
    expect(body).toContain('[[Canción]]');
    await fake.dispose();
  });
});

describe('M1: un H1 con sangría de hasta 3 espacios también da el título', () => {
  it.each(['  # Reunión con [[Cancion]]', '   # Reunión con [[Cancion]]'])('%j', async (h1) => {
    const source = `${h1}\n\nTexto\n`;
    // Hebra saca el título de ese H1 con sangría; el falso no, así que se siembra igual.
    const fake = makeFake({ o: { body: source, title: 'Reunión con [[Cancion]]' }, c: `${FM}# Canción\n` });
    const model = await modelWith(fake, markdownOf(fake));
    const row = linkRows(model)[0];
    await applyChecked(model, deps(fake, spy(fake)));
    expect(row.outcome?.text).toBe(REASON_TEXT.title);
    expect(await bodyOf(fake, 'o')).toBe(source);
    await fake.dispose();
  });
});
