/**
 * La base IndexedDB del plugin (`storage.indexedDB`, que guarda Hebra, no el navegador) y la
 * caché de análisis por `bodySha256`. Los renombrados viven en la misma base
 * (`./renames.ts`): `storage.device` solo admite 1 MiB y 10.000 entradas lo rozarían.
 */
import { CACHE_VERSION } from './analyze';
import type { NoteAnalysis } from './types';

export const ANALYSIS_STORE = 'analisis';
export const RENAMES_STORE = 'renombrados';
const DB_VERSION = 1;

/** El `indexedDB` que da la API (`api.storage.indexedDB`) y el nombre propio del plugin. */
export interface DbSource {
  indexedDB: IDBFactory;
  name: string;
}

export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB: petición fallida'));
  });
}

export function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB: transacción fallida'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB: transacción abortada'));
  });
}

export function openDb(source: DbSource): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = source.indexedDB.open(source.name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore(ANALYSIS_STORE, { keyPath: 'sha256' });
      db.createObjectStore(RENAMES_STORE, { keyPath: 'key' }).createIndex('at', 'at');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB: no se pudo abrir'));
  });
}

export interface AnalysisCache {
  /** Los registros vigentes (de esta `CACHE_VERSION`) de esos hashes. */
  getMany(shas: readonly string[]): Promise<Map<string, NoteAnalysis>>;
  putMany(entries: readonly NoteAnalysis[]): Promise<void>;
  /** Borra los registros cuyo hash ya no está en la biblioteca. Devuelve cuántos. */
  prune(keep: ReadonlySet<string>): Promise<number>;
  /** Tamaño aproximado de lo guardado (UTF-8 del JSON de cada registro). */
  sizeBytes(): Promise<number>;
}

export function idbCache(db: IDBDatabase): AnalysisCache {
  return {
    async getMany(shas) {
      const found = new Map<string, NoteAnalysis>();
      if (shas.length === 0) return found;
      const tx = db.transaction(ANALYSIS_STORE, 'readonly');
      const store = tx.objectStore(ANALYSIS_STORE);
      const rows = await Promise.all(shas.map((sha) => request<NoteAnalysis | undefined>(store.get(sha))));
      for (const row of rows) if (row && row.v === CACHE_VERSION) found.set(row.sha256, row);
      return found;
    },
    async putMany(entries) {
      if (entries.length === 0) return;
      const tx = db.transaction(ANALYSIS_STORE, 'readwrite');
      const store = tx.objectStore(ANALYSIS_STORE);
      for (const entry of entries) store.put(entry);
      await done(tx);
    },
    async prune(keep) {
      const tx = db.transaction(ANALYSIS_STORE, 'readwrite');
      const store = tx.objectStore(ANALYSIS_STORE);
      const keys = await request<IDBValidKey[]>(store.getAllKeys());
      let removed = 0;
      for (const key of keys) {
        if (!keep.has(String(key))) {
          store.delete(key);
          removed += 1;
        }
      }
      await done(tx);
      return removed;
    },
    async sizeBytes() {
      const tx = db.transaction(ANALYSIS_STORE, 'readonly');
      const rows = await request<NoteAnalysis[]>(tx.objectStore(ANALYSIS_STORE).getAll());
      const encoder = new TextEncoder();
      return rows.reduce((sum, row) => sum + encoder.encode(JSON.stringify(row)).length, 0);
    }
  };
}

/** Sin IndexedDB (la API responde `capability-not-available`) la revisión sigue, sin caché. */
export function memoryCache(): AnalysisCache {
  const rows = new Map<string, NoteAnalysis>();
  return {
    async getMany(shas) {
      const found = new Map<string, NoteAnalysis>();
      for (const sha of shas) {
        const row = rows.get(sha);
        if (row && row.v === CACHE_VERSION) found.set(sha, row);
      }
      return found;
    },
    async putMany(entries) {
      for (const entry of entries) rows.set(entry.sha256, entry);
    },
    async prune(keep) {
      let removed = 0;
      for (const sha of [...rows.keys()]) {
        if (!keep.has(sha)) {
          rows.delete(sha);
          removed += 1;
        }
      }
      return removed;
    },
    async sizeBytes() {
      const encoder = new TextEncoder();
      return [...rows.values()].reduce((sum, row) => sum + encoder.encode(JSON.stringify(row)).length, 0);
    }
  };
}
