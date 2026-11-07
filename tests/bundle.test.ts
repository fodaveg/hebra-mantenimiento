// @vitest-environment happy-dom
//
// El módulo que Hebra de verdad descarga: `hebra-main.mjs` (lo genera `npm run build:hebra`,
// y `npm run check` lo construye ANTES de correr los tests). Se carga como lo haría Hebra
// (un módulo ES autocontenido) y se activa contra el host falso de la API 2.x.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/scan/db';
import { renameRegistry } from '../src/scan/renames';
import { makeFake } from './helpers';
// @ts-expect-error -- plain .mjs shared with the build script, without types
import { FORBIDDEN_CALLS, findForbiddenCalls } from '../scripts/forbidden-calls.mjs';

// vitest corre desde la raíz del repo.
const ROOT = cwd();
const BUNDLE = join(ROOT, 'hebra-main.mjs');
const MANIFEST = join(ROOT, 'hebra.json');

// No `runIf`: a missing bundle must turn this file red, not skip it silently.
describe('hebra-main.mjs (hay que construirlo: npm run build:hebra)', () => {
  it('existe (si falta: npm run build:hebra)', () => {
    expect(existsSync(BUNDLE), `${BUNDLE} no existe: ejecuta npm run build:hebra`).toBe(true);
    expect(existsSync(MANIFEST), `${MANIFEST} no existe: ejecuta npm run build:hebra`).toBe(true);
  });

  it('se activa y registra el comando, el botón del raíl y la vista de pestaña', async () => {
    // La ruta es una constante de este fichero, no entrada de nadie.
    const loaded = (await import(/* @vite-ignore */ pathToFileURL(BUNDLE).href)) as {
      activate(api: unknown): Promise<() => Promise<void> | void>;
    };
    expect(typeof loaded.activate).toBe('function');

    const fake = makeFake({ 'n-1': '# Uno\n\n[[Dos]]\n', 'n-2': '# Dos\n' });
    // El host falso v2 aún no tiene gestor de superficies (`ui.registerView` y
    // `workspace.openView` responden `capability-not-available`): esas dos van al host falso
    // 1.x que lo respalda y que sí graba vistas de pestaña. El resto, a la API 2.x.
    const api = new Proxy({}, {
      get(_target, key) {
        if (key === 'ui') return Reflect.get(fake.host.api, key) as unknown;
        if (key === 'workspace') {
          return new Proxy({}, {
            get: (_t, name) =>
              Reflect.get(name === 'openView' ? fake.host.api.workspace : fake.api.workspace, name) as unknown
          });
        }
        return Reflect.get(fake.api, key) as unknown;
      }
    });

    const cleanup = await loaded.activate(api);

    const { commands, ribbon, tabViews } = fake.host.recorded;
    expect(commands.map((c) => c.name)).toEqual(['Mantenimiento: revisar la biblioteca']);
    expect(ribbon).toHaveLength(1);
    expect(ribbon[0]).toMatchObject({ icon: 'circle-check', title: 'Mantenimiento' });
    expect(tabViews).toHaveLength(1);
    expect(tabViews[0]).toMatchObject({ title: 'Mantenimiento', placement: 'tab', icon: 'circle-check' });

    // El comando y el raíl abren la pestaña.
    await commands[0].run();
    ribbon[0].onClick();
    expect(fake.host.recorded.viewOpens.map((o) => o.viewId)).toEqual([tabViews[0].id, tabViews[0].id]);

    // La pestaña enseña el estado vacío, con «Revisar la biblioteca» habilitado.
    const mounted = fake.host.tabView.mount(tabViews[0].id);
    expect(mounted.el.textContent).toContain('Revisa la biblioteca para buscar enlaces rotos');
    const button = mounted.el.querySelector<HTMLButtonElement>('.hebra-mantenimiento-run');
    expect(button?.textContent).toBe('Revisar la biblioteca');
    expect(button?.disabled).toBe(false);

    // Revisar de punta a punta: el recorrido real contra la biblioteca falsa y su caché.
    button?.click();
    await vi.waitFor(() =>
      expect(mounted.el.querySelector('.hebra-mantenimiento-status')?.textContent).toContain('2 notas revisadas')
    );
    mounted.unmount();

    // Un renombrado de título queda anotado.
    fake.renameNoteTitle({ noteId: 'n-2', folderId: 'x', oldTitle: '  Dos VIEJO ', newTitle: 'Dos' });
    await fake.settle();
    const db = await openDb({ indexedDB: fake.api.storage.indexedDB, name: fake.api.storage.indexedDbName('mantenimiento') });
    await vi.waitFor(async () => expect(await renameRegistry(db).lookup('dos viejo')).toBe('n-2'));
    db.close();

    // Apagar quita todo lo registrado.
    await cleanup();
    expect(fake.host.recorded.tabViews).toHaveLength(0);
    expect(fake.host.recorded.commands).toHaveLength(0);
    expect(fake.host.recorded.ribbon).toHaveLength(0);
    await fake.dispose();
  });

  it('el manifiesto describe los ficheros y las capacidades acordadas', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, unknown>;
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    expect(manifest).toMatchObject({
      schema: 1,
      id: 'hebra-mantenimiento',
      name: 'Mantenimiento',
      version: pkg.version,
      apiVersion: '^2.4.0',
      icon: 'circle-check',
      capabilities: { required: ['vault.read', 'vault.write'], optional: [] },
      network: { hosts: [] },
      ageRating: '4+'
    });
    expect(Object.keys(manifest.files as object).sort()).toEqual(['hebra-main.mjs', 'hebra-styles.css']);
  });
});

describe('Mantenimiento no borra, mueve, renombra ni crea nada (criterio 23)', () => {
  it('hebra-main.mjs no contiene ninguna de las llamadas prohibidas', () => {
    const text = readFileSync(BUNDLE, 'utf8');
    expect(findForbiddenCalls(text)).toEqual([]);
  });

  it('la prueba negativa: el escaneo salta con cada nombre prohibido', () => {
    expect(FORBIDDEN_CALLS).toHaveLength(9);
    for (const name of FORBIDDEN_CALLS as string[]) {
      expect(findForbiddenCalls(`await api.vault.${name}(id);`), name).toEqual([name]);
    }
  });

  it('no salta con nombres parecidos que no son la llamada', () => {
    expect(findForbiddenCalls('noteSaved fileTrashed myNoteMove notes.read')).toEqual([]);
  });
});
