import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createFakePluginApiV2, type FakePluginApiV2 } from 'hebra-plugin-api/v2/testing';
import type { FakeSeedNote } from 'hebra-plugin-api/testing';
import type { PluginVault } from 'hebra-plugin-api/v2';
import { idbCache, openDb, type AnalysisCache } from '../src/scan/db';
import { scanLibrary } from '../src/scan/scan';
import type { ScanMarkdown, ScanResult, ScanVault } from '../src/scan/types';

export interface LibraryShape {
  live: number;
  archived?: number;
  trashed?: number;
}

/** Una biblioteca de prueba: `n-00001`…, cada una con descripción y un enlace a la siguiente. */
export function seedNotes(shape: LibraryShape): Record<string, FakeSeedNote> {
  const notes: Record<string, FakeSeedNote> = {};
  const body = (i: number): string =>
    `---\ndescripcion: Nota ${i}\n---\n# Nota ${i}\n\nVa a [[Nota ${i + 1}]] y a [[Nota rota ${i}]].\n`;
  let i = 0;
  for (; i < shape.live; i += 1) notes[`n-${String(i).padStart(5, '0')}`] = body(i);
  for (let a = 0; a < (shape.archived ?? 0); a += 1, i += 1) {
    notes[`n-${String(i).padStart(5, '0')}`] = { body: body(i), archivedAt: 1_000 + a };
  }
  for (let t = 0; t < (shape.trashed ?? 0); t += 1, i += 1) {
    notes[`n-${String(i).padStart(5, '0')}`] = { body: body(i), trashedAt: 2_000 + t };
  }
  return notes;
}

export function makeFake(notes: Record<string, FakeSeedNote>): FakePluginApiV2 {
  return createFakePluginApiV2({
    capabilities: ['vault.read', 'vault.write'],
    notes,
    extensions: {
      indexedDB: () => ({ indexedDB: new IDBFactory(), IDBKeyRange })
    }
  });
}

export async function openTestDb(fake: FakePluginApiV2): Promise<IDBDatabase> {
  return openDb({ indexedDB: fake.api.storage.indexedDB, name: 'mantenimiento-test' });
}

export async function testCache(fake: FakePluginApiV2): Promise<AnalysisCache> {
  return idbCache(await openTestDb(fake));
}

export interface VaultCalls {
  pages: number;
  summaries: number;
  reads: string[];
  inFlight: number;
  maxInFlight: number;
  /** Se llama antes de cada llamada al almacén (para cancelar a mitad). */
  onCall?: (kind: 'page' | 'summary' | 'read' | 'folders') => void;
  /** Ids que `noteSummary` y `noteRead` dicen protegidos. */
  locked: Set<string>;
}

/** Envuelve el almacén para contar llamadas (no milisegundos) y simular notas protegidas. */
export function countingVault(vault: PluginVault): { vault: ScanVault; calls: VaultCalls } {
  const calls: VaultCalls = { pages: 0, summaries: 0, reads: [], inFlight: 0, maxInFlight: 0, locked: new Set() };
  const wrapped: ScanVault = {
    foldersList: () => {
      calls.onCall?.('folders');
      return vault.foldersList();
    },
    notesPage: (cursor, limit, scope) => {
      calls.onCall?.('page');
      calls.pages += 1;
      return vault.notesPage(cursor, limit, scope);
    },
    noteSummary: async (ids) => {
      calls.onCall?.('summary');
      calls.summaries += 1;
      const list = await vault.noteSummary(ids);
      return list.map((s) => (calls.locked.has(s.id) ? { ...s, locked: true } : s));
    },
    noteRead: async (id) => {
      calls.onCall?.('read');
      calls.reads.push(id);
      calls.inFlight += 1;
      calls.maxInFlight = Math.max(calls.maxInFlight, calls.inFlight);
      try {
        await Promise.resolve();
        const note = await vault.noteRead(id);
        return note && calls.locked.has(id) ? { ...note, locked: true, body: null } : note;
      } finally {
        calls.inFlight -= 1;
      }
    }
  };
  return { vault: wrapped, calls };
}

/**
 * `markdown` del host falso, con `frontmatter` de verdad: el falso devuelve siempre `null`
 * (Hebra real lee el YAML), así que aquí se parsean las líneas `clave: valor` del bloque.
 */
export function markdownOf(fake: FakePluginApiV2): ScanMarkdown {
  return {
    links: (body) => fake.api.markdown.links(body),
    frontmatter: (body) => {
      const match = /^---\n([\s\S]*?)\n---/.exec(body);
      if (!match) return null;
      const out: Record<string, unknown> = {};
      for (const line of match[1].split('\n')) {
        const pair = /^([^:]+):\s*(.*)$/.exec(line);
        if (pair) out[pair[1].trim()] = pair[2].trim();
      }
      return out;
    }
  };
}

/** Recorre la biblioteca falsa (sin caché ni esperas) y devuelve el resultado del recorrido. */
export async function scanOf(fake: FakePluginApiV2): Promise<ScanResult> {
  return scanLibrary(
    { vault: fake.api.vault, markdown: markdownOf(fake), cache: null },
    { pause: () => Promise.resolve() }
  );
}
