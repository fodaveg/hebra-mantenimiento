import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createFakePluginApiV2, type FakePluginApiV2 } from 'hebra-plugin-api/v2/testing';
import type { FakeSeedNote } from 'hebra-plugin-api/testing';
import type { PluginVault } from 'hebra-plugin-api/v2';
import { idbCache, openDb, type AnalysisCache } from '../src/scan/db';
import { scanLibrary } from '../src/scan/scan';
import type { ApplyMarkdown } from '../src/apply/apply';
import type { ScanResult, ScanVault } from '../src/scan/types';

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
 * `markdown` del host falso, con `frontmatter` y `setProperty` de verdad: el falso devuelve
 * siempre `null` y no implementa `setProperty` (Hebra real tiene el lector de YAML). Aquí se
 * parsean las líneas `clave: valor` del bloque, con valores entre comillas como JSON, y se
 * escribe `clave: "valor"` con `JSON.stringify` (YAML válido, también con `:`, comillas o `\n`).
 */
export function markdownOf(fake: FakePluginApiV2): ApplyMarkdown {
  const block = /^---\n([\s\S]*?)\n---(\n|$)/;
  return {
    links: (body) => fake.api.markdown.links(body),
    frontmatter: (body) => {
      const match = block.exec(body);
      if (!match) return null;
      const out: Record<string, unknown> = {};
      for (const line of match[1].split('\n')) {
        const pair = /^([^:]+):\s*(.*)$/.exec(line);
        if (!pair) continue;
        const raw = pair[2].trim();
        let value: unknown = raw;
        if (raw.startsWith('"')) {
          try {
            value = JSON.parse(raw);
          } catch {
            value = raw;
          }
        }
        out[pair[1].trim()] = value;
      }
      return out;
    },
    setProperty: (body, key, value) => {
      const line = value === null ? null : `${key}: ${JSON.stringify(value)}`;
      const match = block.exec(body);
      if (!match) return line === null ? body : `---\n${line}\n---\n${body}`;
      const kept = match[1].split('\n').filter((l) => !l.startsWith(`${key}:`));
      if (line !== null) kept.push(line);
      return `---\n${kept.join('\n')}\n---${match[2]}${body.slice(match[0].length)}`;
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

/** Un `PanelHost` de mentira que apunta lo que se le pide y deja disparar «cambió la biblioteca». */
export function stubHost(applyChecked?: import('../src/panel').PanelHost['applyChecked']): {
  host: import('../src/panel').PanelHost;
  calls: { opened: string[]; searched: string[]; folders: string[]; previews: string[] };
  emitChange(): void;
} {
  const calls = { opened: [] as string[], searched: [] as string[], folders: [] as string[], previews: [] as string[] };
  const listeners = new Set<() => void>();
  return {
    calls,
    emitChange: () => listeners.forEach((l) => l()),
    host: {
      openNote: (id) => void calls.opened.push(id),
      openSearch: (q) => void calls.searched.push(q),
      selectFolder: (id) => void calls.folders.push(id),
      onNotesChange: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      applyChecked: applyChecked ?? (() => Promise.reject(new Error('applyChecked no esperado'))),
      linkPreview: (noteId, key, fix) => {
        calls.previews.push(`${noteId}|${key.target}|${fix?.newTarget ?? ''}`);
        return Promise.resolve({ before: `antes ${key.target}`, after: `después ${fix?.newTarget ?? ''}` });
      }
    }
  };
}
