/**
 * Entrada de Mantenimiento como plugin EXTERNO de Hebra (`hebra-main.mjs`, manifiesto
 * `hebra.json`). Hebra importa este módulo y llama a `activate(api)`; lo que devuelve es la
 * limpieza que corre al apagar el plugin.
 *
 * Registra el comando de paleta, el botón del raíl y la vista de pestaña, y anota los
 * renombrados de títulos. Este plugin solo pide `vault.read` y `vault.write`, y NUNCA borra,
 * mueve ni renombra (`tests/bundle.test.ts` lo comprueba sobre el módulo construido).
 */
import type { HebraPluginApi, PluginCleanup } from 'hebra-plugin-api/v2';
import { mountPanel, PANEL_TITLE, type PanelHost, type RunReview } from './panel';
import { analyze } from './results/model';
import { linePreview } from './results/preview';
import { idbCache, memoryCache, openDb, type AnalysisCache } from './scan/db';
import { renameRegistry, type RenameRegistry } from './scan/renames';
import { scanLibrary } from './scan/scan';

export const VIEW_ID = 'mantenimiento';
export const COMMAND_ID = 'mantenimiento-revisar-la-biblioteca';
export const COMMAND_NAME = 'Mantenimiento: revisar la biblioteca';
export const RIBBON_ICON = 'circle-check';
export const DB_NAME = 'mantenimiento';
/** Lecturas de cuerpo a la vez para las vistas previas de las filas. */
const PREVIEW_READS = 4;

/** Abre la base del plugin una vez; sin IndexedDB (no la da la plataforma) devuelve `null`. */
function openOnce(api: HebraPluginApi): () => Promise<IDBDatabase | null> {
  let opening: Promise<IDBDatabase | null> | null = null;
  return () => {
    opening ??= (async () => {
      try {
        return await openDb({ indexedDB: api.storage.indexedDB, name: api.storage.indexedDbName(DB_NAME) });
      } catch {
        return null;
      }
    })();
    return opening;
  };
}

export function activate(api: HebraPluginApi): Promise<PluginCleanup> {
  const open = (): void => api.workspace.openView(VIEW_ID);
  const database = openOnce(api);
  // Un solo registro: serializa sus escrituras y lleva el orden de inserción.
  const registry: Promise<RenameRegistry | null> = database().then((db) => (db ? renameRegistry(db) : null));

  // Cuerpos de las notas que enseñan vista previa: se vacía en cada revisión.
  let bodies = new Map<string, Promise<string | null>>();
  let reading = 0;
  const waiting: (() => void)[] = [];
  const slot = async (): Promise<void> => {
    if (reading >= PREVIEW_READS) await new Promise<void>((resolve) => waiting.push(resolve));
    reading += 1;
  };
  const release = (): void => {
    reading -= 1;
    waiting.shift()?.();
  };
  const bodyOf = (id: string): Promise<string | null> => {
    let body = bodies.get(id);
    if (!body) {
      body = (async () => {
        await slot();
        try {
          const note = await api.vault.noteRead(id);
          return note && !note.locked ? note.body : null;
        } finally {
          release();
        }
      })();
      bodies.set(id, body);
    }
    return body;
  };

  const host: PanelHost = {
    openNote: (id) => api.workspace.openNote(id),
    openSearch: (query) => api.workspace.openSearch(query),
    selectFolder: (id) => api.workspace.selectFolder(id),
    onNotesChange: (listener) => api.workspace.onNotesChange(() => listener()),
    linkPreview: async (noteId, key, fix) => {
      const body = await bodyOf(noteId);
      return body === null ? null : linePreview(body, api.markdown.links(body), key, fix);
    }
  };

  const review: RunReview = async (signal, onProgress) => {
    bodies = new Map();
    const db = await database();
    const cache: AnalysisCache = db ? idbCache(db) : memoryCache();
    const scan = await scanLibrary({ vault: api.vault, markdown: api.markdown, cache }, { signal, onProgress });
    onProgress({ phase: 'detecting', done: 0, total: 1 });
    const renames = await registry;
    return analyze(scan, (title) => (renames ? renames.lookup(title) : Promise.resolve(null)));
  };

  const offView = api.ui.registerView({
    id: VIEW_ID,
    title: PANEL_TITLE,
    icon: RIBBON_ICON,
    placement: 'tab',
    mount: (el) => mountPanel(el, review, host)
  });
  const offCommand = api.ui.registerCommand({ id: COMMAND_ID, name: COMMAND_NAME, run: open });
  const offRibbon = api.ui.ribbon({ icon: RIBBON_ICON, title: PANEL_TITLE, onClick: open });
  const offRenames = api.workspace.onNoteTitleRenamed((event) => {
    void registry.then((r) => r?.record(event.oldTitle, event.noteId)).catch(() => undefined);
  });

  return Promise.resolve(() => {
    offRenames();
    offRibbon();
    offCommand();
    offView();
    void database().then((db) => db?.close());
  });
}
