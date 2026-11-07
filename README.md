# Mantenimiento

Plugin de [Hebra](https://github.com/fodaveg/hebra) (API 2.4 o posterior) que revisa una biblioteca y propone arreglos con vista previa.

## Qué hace

Busca, y enseña antes de tocar nada:

- enlaces rotos,
- notas sin descripción,
- carpetas duplicadas,
- notas a las que nada enlaza.

Cada arreglo se propone con una vista previa y solo se aplica lo que la persona marca.

> Estado: 0.1.1. Revisa la biblioteca, enseña los resultados por tipo con vista previa y aplica lo que se marca. La pestaña tiene el aspecto de Ajustes de Hebra (letra, botones, campos y casillas de Hebra, en claro y oscuro) aunque Hebra no le dé su hoja base.

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
- `src/panel.ts`, `src/results/view.ts` y `src/hebra-styles.css`: la pestaña. Solo variables CSS de Hebra, cada una con un valor de reserva, sin colores propios. La letra Figtree (`src/fonts/`, licencia SIL OFL 1.1 en `src/fonts/OFL-Figtree.txt`) la mete el build en `hebra-styles.css` como `data:`, porque el marco del plugin solo admite letras `data:` o de su origen.
- `scripts/build-hebra.mjs`: construye el módulo, pasa el guardarraíl (sin imports, sin `node:`, sin llamadas prohibidas) y genera `hebra.json` con los sha256.
- `scripts/verify-release.mjs` y `scripts/sign-publish.mjs`: verifican el borrador de la release (tres ficheros) y lo firman y publican desde la máquina de la autora (`npm run release:sign-publish -- <tag>`). La clave privada vive en `~/.config/hebra-plugin-signing/hebra-mantenimiento.key` y nunca entra en el repositorio.

`hebra-plugin-api` está fijada a `github:fodaveg/hebra-plugin-api#v2.4.0`. El host falso v2 no tiene aún gestor de superficies, así que el test de activación enruta `ui` y `workspace.openView` al host falso 1.x que lo respalda; el resto va por la API 2.x.

**Publicar exige `npm run release:check` en local.** Varios tests comprueban el plugin contra el `api.markdown` REAL de Hebra (`frontmatter`, `setProperty`, `links`), que el host falso no imita. Para ello `npm run build:real-markdown` empaqueta ese módulo desde un checkout de Hebra con la API 2.4 (`HEBRA_SRC=<ruta>`, por defecto `~/code/hebra-cand-20261107`) en `.real/frame-markdown.mjs`. Ese bundle NO entra en el repositorio (Hebra es privado y sin licencia; este plugin es público y MIT), así que sin él esos tests se saltan solos, y el CI, que no lo tiene, se queda como está: solo corre `npm run check`. `release:check` construye el bundle, falla si falta, ejecuta lint, tipos, build y todos los tests, y falla si alguno queda saltado.

## Cómo recorre la biblioteca

`src/scan/` (P2): carpetas, notas vivas y archivadas por páginas, resúmenes de 200 en 200 y lectura de cuerpos con 4 lecturas como máximo en vuelo, en trozos de 50 notas con una espera entre trozos. Nunca lee una nota protegida. De cada cuerpo guarda un derivado (enlaces y si tiene descripción) en la IndexedDB del plugin, con clave `bodySha256`: una segunda revisión sin cambios no lee ningún cuerpo. Los renombrados de título (`workspace.onNoteTitleRenamed`) se anotan aparte, hasta 10.000.

## Licencia

MIT.
