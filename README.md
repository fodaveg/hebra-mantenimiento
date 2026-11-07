# Mantenimiento

Plugin de [Hebra](https://github.com/fodaveg/hebra) (API 2.4 o posterior) que revisa una biblioteca y propone arreglos con vista previa.

## Qué hace

Busca, y enseña antes de tocar nada:

- enlaces rotos,
- notas sin descripción,
- carpetas duplicadas,
- notas a las que nada enlaza.

Cada arreglo se propone con una vista previa y solo se aplica lo que la persona marca.

> Estado: 0.1.0 es el esqueleto. Registra el comando «Mantenimiento: revisar la biblioteca», un botón en el raíl y la pestaña «Mantenimiento» con su estado vacío (el botón «Revisar la biblioteca» sigue deshabilitado). La revisión llega en las siguientes versiones.

## Qué no hace nunca

- No borra nada: ni notas, ni ficheros, ni carpetas.
- No mueve ni renombra notas ni carpetas.
- No toca la numeración Johnny.Decimal.
- No escribe sin vista previa.

Pide solo las capacidades `vault.read` y `vault.write`, no usa red (`network.hosts` vacío) y su edad mínima es 4+. Que no borra, mueve, renombra ni crea nada lo comprueba un test sobre el módulo construido (`tests/bundle.test.ts`, también el build): `hebra-main.mjs` no puede contener `noteTrash`, `fileTrash`, `folderTrashEmpty`, `noteMove`, `folderRename`, `folderMove`, `folderCreate`, `noteCreate` ni `noteSave`.

## Instalación

Desde el índice de plugins de Hebra, cuando esté publicado: Ajustes, Plugins, Mantenimiento. Un Hebra anterior a la 2.4 lo deja apagado con «Necesita una versión más nueva de Hebra».

Clave pública de firma (minisign) de las releases:

```
RWRBYHMCiJMoGjqUSa6JHPzM9b7n4RxpTKII/EYu/mEnc/O3qxWIWOes
```

## Desarrollo

```
npm install
npm run check        # lint, tipos, build de Hebra y tests
npm run build:hebra  # genera hebra-main.mjs, hebra-styles.css y hebra.json (no se editan a mano)
npm test             # vitest run --maxWorkers=1
```

- `src/main.ts`: `activate(api)`; registra comando, raíl y vista de pestaña.
- `src/panel.ts` y `src/hebra-styles.css`: la pestaña. Solo variables CSS de Hebra, sin colores propios.
- `scripts/build-hebra.mjs`: construye el módulo, pasa el guardarraíl (sin imports, sin `node:`, sin llamadas prohibidas) y genera `hebra.json` con los sha256.
- `scripts/verify-release.mjs` y `scripts/sign-publish.mjs`: verifican el borrador de la release (tres ficheros) y lo firman y publican desde la máquina de la autora (`npm run release:sign-publish -- <tag>`). La clave privada vive en `~/.config/hebra-plugin-signing/hebra-mantenimiento.key` y nunca entra en el repositorio.

`hebra-plugin-api` está fijada a `github:fodaveg/hebra-plugin-api#v2.2.0` porque la 2.4.0 aún no está publicada. **Cuando exista, subirla a `#v2.4.0`** en `package.json` (y regenerar `package-lock.json`); hasta entonces no se usan tipos de la 2.4. La 2.2 todavía no sirve las vistas de pestaña en el marco, así que los tests las ejercitan por el host falso 1.x que respalda al de la 2.x.

## Licencia

MIT.
