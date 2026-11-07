/**
 * Entrada de Mantenimiento como plugin EXTERNO de Hebra (`hebra-main.mjs`, manifiesto
 * `hebra.json`). Hebra importa este módulo y llama a `activate(api)`; lo que devuelve es la
 * limpieza que corre al apagar el plugin.
 *
 * P1: registra el comando de paleta, el botón del raíl y la vista de pestaña. La revisión
 * llega después; este plugin solo pide `vault.read` y `vault.write`, y NUNCA borra, mueve ni
 * renombra (`tests/bundle.test.ts` lo comprueba sobre el módulo construido).
 */
import type { HebraPluginApi, PluginCleanup } from 'hebra-plugin-api/v2';
import { mountPanel, PANEL_TITLE } from './panel';

export const VIEW_ID = 'mantenimiento';
export const COMMAND_ID = 'mantenimiento-revisar-la-biblioteca';
export const COMMAND_NAME = 'Mantenimiento: revisar la biblioteca';
export const RIBBON_ICON = 'wrench';

export function activate(api: HebraPluginApi): Promise<PluginCleanup> {
  const open = (): void => api.workspace.openView(VIEW_ID);

  const offView = api.ui.registerView({
    id: VIEW_ID,
    title: PANEL_TITLE,
    icon: RIBBON_ICON,
    placement: 'tab',
    mount: (el) => mountPanel(el)
  });
  const offCommand = api.ui.registerCommand({ id: COMMAND_ID, name: COMMAND_NAME, run: open });
  const offRibbon = api.ui.ribbon({ icon: RIBBON_ICON, title: PANEL_TITLE, onClick: open });

  return Promise.resolve(() => {
    offRibbon();
    offCommand();
    offView();
  });
}
