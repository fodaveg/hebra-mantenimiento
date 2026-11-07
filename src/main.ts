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
import { mountPanel, PANEL_TITLE } from './panel';
import { idbCache, memoryCache, openDb, type AnalysisCache } from './scan/db';
import { renameRegistry } from './scan/renames';
import { scanLibrary } from './scan/scan';

export const VIEW_ID = 'mantenimiento';
export const COMMAND_ID = 'mantenimiento-revisar-la-biblioteca';
export const COMMAND_NAME = 'Mantenimiento: revisar la biblioteca';
export const RIBBON_ICON = 'circle-check';
export const DB_NAME = 'mantenimiento';

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

  const offView = api.ui.registerView({
    id: VIEW_ID,
    title: PANEL_TITLE,
    icon: RIBBON_ICON,
    placement: 'tab',
    mount: (el) =>
      mountPanel(el, async (signal, onProgress) => {
        const db = await database();
        const cache: AnalysisCache = db ? idbCache(db) : memoryCache();
        return scanLibrary(
          { vault: api.vault, markdown: api.markdown, cache },
          { signal, onProgress }
        );
      })
  });
  const offCommand = api.ui.registerCommand({ id: COMMAND_ID, name: COMMAND_NAME, run: open });
  const offRibbon = api.ui.ribbon({ icon: RIBBON_ICON, title: PANEL_TITLE, onClick: open });
  // Un solo registro: serializa sus escrituras y lleva el orden de inserción.
  const registry = database().then((db) => (db ? renameRegistry(db) : null));
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
