/**
 * Registro de renombrados: cuando Hebra renombra una nota por su título
 * (`workspace.onNoteTitleRenamed`), guarda «título viejo canónico -> id de la nota». P3 lo usa
 * para saber a qué nota apuntaba un `[[Título viejo]]` que ya no resuelve. Vive en la IndexedDB
 * del plugin (`./db.ts`), por dispositivo, con un tope de 10.000 entradas: al pasarlo salen
 * primero las más antiguas.
 */
import { done, RENAMES_STORE, request } from './db';

export const MAX_RENAMES = 10_000;

/** NFKC, recortado y en minúsculas: la forma en que se compara un título con un enlace. */
export function canonicalTitle(title: string): string {
  return title.normalize('NFKC').trim().toLowerCase();
}

interface RenameRow {
  key: string;
  id: string;
  /** Orden de inserción: creciente, aunque el reloj no avance. */
  at: number;
}

export interface RenameRegistry {
  /** Anota que la nota `noteId` se llamaba `oldTitle`. Un título vacío no se anota. */
  record(oldTitle: string, noteId: string): Promise<void>;
  /** El id de la nota que se llamaba así, o `null`. */
  lookup(title: string): Promise<string | null>;
  count(): Promise<number>;
}

export function renameRegistry(
  db: IDBDatabase,
  options: { max?: number; now?: () => number } = {}
): RenameRegistry {
  const max = options.max ?? MAX_RENAMES;
  const now = options.now ?? Date.now;
  let lastAt: number | null = null;
  // Un solo escritor a la vez: `lastAt` y la poda dependen del orden.
  let queue: Promise<unknown> = Promise.resolve();

  const newestAt = async (): Promise<number> => {
    const tx = db.transaction(RENAMES_STORE, 'readonly');
    const cursor = await request(tx.objectStore(RENAMES_STORE).index('at').openCursor(null, 'prev'));
    return cursor ? (cursor.value as RenameRow).at : 0;
  };

  const write = async (oldTitle: string, noteId: string): Promise<void> => {
    const key = canonicalTitle(oldTitle);
    if (key === '') return;
    lastAt ??= await newestAt();
    lastAt = Math.max(lastAt + 1, now());
    const tx = db.transaction(RENAMES_STORE, 'readwrite');
    const store = tx.objectStore(RENAMES_STORE);
    store.put({ key, id: noteId, at: lastAt } satisfies RenameRow);
    const total = await request(store.count());
    let excess = total - max;
    if (excess > 0) {
      const cursor = store.index('at').openCursor();
      await new Promise<void>((resolve, reject) => {
        cursor.onerror = () => reject(cursor.error ?? new Error('IndexedDB: cursor fallido'));
        cursor.onsuccess = () => {
          const at = cursor.result;
          if (!at || excess <= 0) return resolve();
          at.delete();
          excess -= 1;
          at.continue();
        };
      });
    }
    await done(tx);
  };

  return {
    record(oldTitle, noteId) {
      const run = queue.then(() => write(oldTitle, noteId));
      queue = run.catch(() => undefined);
      return run;
    },
    async lookup(title) {
      const row = await request<RenameRow | undefined>(
        db.transaction(RENAMES_STORE, 'readonly').objectStore(RENAMES_STORE).get(canonicalTitle(title))
      );
      return row?.id ?? null;
    },
    async count() {
      return request(db.transaction(RENAMES_STORE, 'readonly').objectStore(RENAMES_STORE).count());
    }
  };
}
