/**
 * El recorrido de la biblioteca (P2): carpetas, notas vivas y archivadas, resúmenes, y lectura
 * de los cuerpos que la caché no tiene ya por `bodySha256`.
 *
 * Reglas que cumple (y que `tests/scan.test.ts` cuenta, no mide en ms):
 * - Páginas de `notesPage` hasta `nextCursor === null`, en los ámbitos `all` y `archive`
 *   (la papelera no sale en ninguno).
 * - Resúmenes de 200 en 200 (`noteSummary`).
 * - Como mucho `concurrency` (4) `noteRead` en vuelo; nunca de una nota protegida.
 * - Se procesa en trozos de `chunkSize` (50) notas; entre trozo y trozo hay una espera
 *   (`pause`), así que ningún trozo analiza más de 50 cuerpos.
 * - Cancelar (`AbortSignal`) deja de pedir al almacén al instante (se mira antes de CADA
 *   página, lote, trozo y lectura) y rechaza con `ScanCancelledError`: nunca un resultado parcial.
 */
import { analyzeBody } from './analyze';
import type { AnalysisCache } from './db';
import {
  ScanCancelledError,
  type NoteAnalysis,
  type ScanMarkdown,
  type ScannedNote,
  type ScanProgress,
  type ScanResult,
  type ScanVault
} from './types';
import type { PluginNoteSummary } from 'hebra-plugin-api/v2';

export const PAGE_SIZE = 200;
export const SUMMARY_BATCH = 200;
export const READ_CONCURRENCY = 4;
export const CHUNK_SIZE = 50;

export interface ScanDeps {
  vault: ScanVault;
  markdown: ScanMarkdown;
  /** Sin caché cada revisión lee todos los cuerpos. */
  cache: AnalysisCache | null;
}

export interface ScanOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ScanProgress) => void;
  /** La espera entre trozos (por defecto, ceder el hilo con un `setTimeout(0)`). */
  pause?: () => Promise<void>;
  chunkSize?: number;
  concurrency?: number;
}

const yieldThread = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export async function scanLibrary(deps: ScanDeps, options: ScanOptions = {}): Promise<ScanResult> {
  const { vault, markdown, cache } = deps;
  const { signal, onProgress } = options;
  const pause = options.pause ?? yieldThread;
  const chunkSize = Math.max(1, options.chunkSize ?? CHUNK_SIZE);
  const concurrency = Math.max(1, options.concurrency ?? READ_CONCURRENCY);
  const check = (): void => {
    if (signal?.aborted) throw new ScanCancelledError();
  };
  const progress = (phase: ScanProgress['phase'], doneCount: number, total: number): void =>
    onProgress?.({ phase, done: doneCount, total });

  // 1. Carpetas.
  check();
  progress('folders', 0, 1);
  const folders = await vault.foldersList();
  progress('folders', 1, 1);

  // 2. Ids de las notas vivas y de las archivadas (la papelera no sale en ninguno).
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const scope of [{ kind: 'all' }, { kind: 'archive' }] as const) {
    let cursor: string | null = null;
    do {
      check();
      const page = await vault.notesPage(cursor, PAGE_SIZE, scope);
      for (const item of page.items) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          ids.push(item.id);
        }
      }
      progress('listing', ids.length, 0);
      cursor = page.nextCursor;
    } while (cursor !== null);
  }

  // 3. Resúmenes: `bodySha256`, `locked`, `archivedAt`, `conflictOf`.
  const summaries: PluginNoteSummary[] = [];
  for (let start = 0; start < ids.length; start += SUMMARY_BATCH) {
    check();
    progress('summaries', start, ids.length);
    for (const summary of await vault.noteSummary(ids.slice(start, start + SUMMARY_BATCH))) {
      if (summary.trashedAt === null) summaries.push(summary);
    }
  }
  progress('summaries', ids.length, ids.length);

  // 4. Cuerpos, por trozos.
  const notes: ScannedNote[] = [];
  const stats = { notes: 0, archived: 0, locked: 0, reads: 0, cacheHits: 0 };
  progress('reading', 0, summaries.length);
  for (let start = 0; start < summaries.length; start += chunkSize) {
    check();
    const chunk = summaries.slice(start, start + chunkSize);
    const wanted = chunk.filter((s) => !s.locked);
    const cached = cache ? await cache.getMany([...new Set(wanted.map((s) => s.bodySha256))]) : new Map<string, NoteAnalysis>();
    const analyses = new Map<string, NoteAnalysis | null>();
    const toRead: PluginNoteSummary[] = [];
    for (const summary of wanted) {
      const hit = cached.get(summary.bodySha256);
      if (hit) {
        analyses.set(summary.id, hit);
        stats.cacheHits += 1;
      } else toRead.push(summary);
    }

    const fresh: NoteAnalysis[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        check();
        const summary = toRead[next];
        next += 1;
        if (summary === undefined) return;
        stats.reads += 1;
        const note = await vault.noteRead(summary.id);
        if (note === null || note.locked || note.body === null) {
          analyses.set(summary.id, null);
          continue;
        }
        // El hash que cuenta es el del resumen, el que ya miró la caché: una nota que cambió
        // entre el resumen y la lectura se guarda con el cuerpo que se leyó bajo su hash nuevo.
        const sha256 = note.revision.bodySha256;
        const analysis = analyzeBody(markdown, sha256, note.body);
        analyses.set(summary.id, analysis);
        fresh.push(analysis);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, toRead.length) }, worker));
    check();
    if (cache) await cache.putMany(fresh);

    for (const summary of chunk) {
      notes.push({
        id: summary.id,
        title: summary.title,
        folderId: summary.folderId,
        archivedAt: summary.archivedAt,
        conflictOf: summary.conflictOf,
        locked: summary.locked,
        updatedAt: summary.updatedAt,
        bodySha256: summary.bodySha256,
        analysis: summary.locked ? null : (analyses.get(summary.id) ?? null)
      });
      stats.notes += 1;
      if (summary.archivedAt !== null) stats.archived += 1;
      if (summary.locked) stats.locked += 1;
    }
    progress('reading', Math.min(start + chunkSize, summaries.length), summaries.length);
    await pause();
  }
  check();
  if (cache) await cache.prune(new Set(summaries.map((s) => s.bodySha256)));
  return { folders, notes, stats };
}
