# Spec del plugin de mantenimiento de Hebra (copia de trabajo, 7 nov 2026)

Fuente: nota de Hebra "2026-11-07 - Spec del plugin de mantenimiento de Hebra" (hebra://note/d32eb139-f69b-43dc-85de-6b16c0442281). Esta copia trae solo lo que necesitan las piezas P3 a P7. Las decisiones de comportamiento son de David y no se reabren.

## Qué encuentra y qué hace

| Hallazgo | Comportamiento (David) |
| --- | --- |
| Enlace roto con un único destino que casa | Arreglo ya marcado: reescribe el enlace a la nota correcta |
| Enlace roto con varios candidatos o ninguno, y enlace ambiguo | Enseña candidatos, sin marcar; elige David |
| Nota sin descripción | Propone una sacada del primer párrafo, SIN marcar |
| Carpetas duplicadas | Solo avisa |
| Notas a las que nada enlaza | Solo avisa |

### 1. Qué cuenta como enlace y cuándo está roto (mismo criterio que la app; `markdown.links` de la API 2.4 ya lo aplica)

- Solo wikilinks e incrustaciones (`[[...]]`, `![[...]]`) e imágenes Markdown con destino relativo. `[texto](Nota.md)` y `[texto](hebra://note/<id>)` NO son enlaces a nota.
- No cuentan los de frontmatter, bloque de código, código en línea, etiqueta HTML ni comentario `%%...%%`.
- No se juzgan: `[[#Encabezado]]` (self-heading), `[[task:...]]` y `[[list:...]]` (lumbre), `[[{{today}}]]` (template), vacíos (empty). Que el encabezado exista NO se comprueba.
- Búsqueda por título: título canónico del enlace (NFKC, recortado, minúsculas; NO quita acentos) contra el de cada nota viva fuera de la papelera. Las archivadas SÍ cuentan como destino. Las protegidas también (su título se conoce).
- `[[ruta/Nota]]`: la ruta solo desempata entre varias notas con ese título; compara los últimos segmentos de la ruta de carpetas en minúsculas.
- `[[id:...]]`: existe si hay una nota viva con ese id fuera de la papelera.
- Estado: ningún candidato = sin destino; uno = bien; más de uno tras desempatar = ambiguo. Una copia de conflicto (`conflictOf` no nulo) es un candidato más.
- Alcance v1: solo destinos que son NOTA (note-title, note-path, `.md`, note-id). Ficheros (`[[plano.pdf]]`, `![[foto.png]]`) y hashes (`sha256:`) quedan fuera.
- Un título de más de 200 caracteres llega recortado al plugin: esos enlaces se tratan como "no juzgado".

### 2. Candidatos para un enlace sin destino

Un candidato es una nota viva fuera de la papelera que cumple una de:
- R1. Fue renombrada desde ese título en este dispositivo (registro de renombrados de P2).
- R2. Mismo título ignorando acentos, mayúsculas, espacios repetidos y signos de puntuación (`[[Cancion]]` y "Canción").
- R3. El enlace no lleva número JD y el título de la nota es ese texto con un prefijo JD delante (`[[Viajes]]` y "11.01 Viajes"). Prefijo JD como JDex Manager: `10-19`, `11`, `11.01`, `11.01+`, sistema `D01.` (ver `~/code/jdex-manager/src/jd/parse.ts:24-61`).

- Único destino: se marca el arreglo solo si la unión de R1, R2 y R3 da exactamente una nota, no es copia de conflicto y, al volver a resolver el enlace ya reescrito con el criterio del punto 1, da esa nota y solo esa.
- Nunca se marca un arreglo que cambie un número JD escrito en el enlace (`[[11.01 Viajes]]` -> "11.05 Viajes" se enseña sin marcar).
- Cómo se reescribe: solo el destino; se conservan alias, encabezado y el `!`: `[[Cancion#Letra|la canción]]` -> `[[Canción#Letra|la canción]]`. Si el título nuevo lo comparten varias notas, se añade la ruta de carpetas más corta que lo deja único y, si no tenía alias, se pone como alias el texto que se veía antes. Todas las apariciones del mismo enlace en la misma nota se reescriben juntas.
- Ambiguo: candidatos sin marcar; al elegir uno se reescribe con la ruta más corta que lo deja único.
- Sin candidatos: "Abrir nota" y "Buscar" (abre la búsqueda de Hebra con el texto del enlace). Sin arreglo.

### 3. Nota sin descripción

- Tiene descripción si `descripcion` o `description` tienen texto no vacío (o una lista con algún texto).
- Se excluyen: protegidas, copias de conflicto, archivadas y notas con la propiedad `jd` en el frontmatter (índices de JDex Manager).
- Propuesta: el primer párrafo de prosa del cuerpo, saltando frontmatter, encabezados, listas, citas y avisos, tablas, bloques de código, comentarios HTML e incrustaciones. Se limpia el Markdown (un wikilink queda como su alias o su título, un enlace como su texto, sin `*_~` ni etiquetas HTML) y se juntan los espacios. Si pasa de 200 caracteres, se corta en el último final de frase antes de 200; si no hay, en el último espacio, con "..." al final. Misma limpieza que `firstSentence` de `~/code/jdex-manager/src/jd/description.ts:6-68`, pero con el párrafo entero.
- Sin párrafo: se lista con "Sin propuesta" y "Abrir nota", sin casilla.
- Si `api.markdown.setProperty` devuelve el cuerpo sin cambios: "No se puede escribir la propiedad sin riesgo", sin casilla.
- La propiedad que se escribe es `descripcion` (sin tilde).

### 4. Carpetas duplicadas

Dos o más carpetas vivas con el MISMO padre cuyo nombre es igual tras NFC, recortar y minúsculas. NO se marcan: misma carpeta de patrón dentro de distintos IDs (distinto padre); "11.01 Viajes" y "11.02 Viajes" (nombre distinto). Cada aviso: ruta, nombre exacto de cada carpeta, cuántas notas tiene cada una, "Ver carpeta". Sin botón de fusionar.

### 5. Notas a las que nada enlaza

Nota viva, no archivada, fuera de la papelera, no copia de conflicto, cuyo título canónico y cuyo id no aparecen como destino de ningún enlace de OTRA nota viva (archivadas incluidas como fuente). Compara por título canónico o por id, sin mirar la ruta ni si el enlace es ambiguo. Los enlaces dentro de notas protegidas no cuentan. Se enseñan agrupadas por carpeta y plegadas. Solo avisa.

## Cómo se usa

- Pestaña "Mantenimiento", comando "Mantenimiento: revisar la biblioteca", botón en el raíl.
- Flujo:
  1. Revisar (P2 ya lo hace).
  2. Resultados: cuatro secciones con recuento: "Enlaces rotos (37, 12 con arreglo marcado)", "Sin descripción (210)", "Carpetas duplicadas (3)", "Sin enlaces entrantes (640)". Cada fila: título con "Abrir", la línea afectada y la vista previa antes -> después. Secciones grandes por grupos de carpeta y de 100 en 100; nunca más de 200 filas pintadas a la vez.
  3. Elegir: casilla en cada fila con arreglo; seguras ya marcadas, de criterio sin marcar. Enlace con varios candidatos: selector (título y ruta); elegir uno marca la fila. Arriba "Marcar todo lo seguro" y "Desmarcar todo".
  4. Aplicar: un botón "Aplicar 15 cambios en 12 notas". Sin diálogo: la vista previa es la confirmación.
  5. Después: "Aplicados 14 cambios en 11 notas. 1 nota cambió mientras tanto y no se tocó." Cada fila aplicada pasa a "Hecho" con "Deshacer desde la nota". Las no aplicadas dicen por qué (cambió, protegida, ya no existe). Se releen solo las notas tocadas y se actualizan los recuentos.
  6. Si la biblioteca cambia con la pestaña abierta: aviso "La biblioteca ha cambiado desde la revisión" con "Revisar de nuevo".

## Escribir (P6)

- Siempre con `vault.notesRewriteBatch(entries, { cause, touchUpdatedAt: false })`, lotes de 200, `strictRevision: true`. Causa: "Mantenimiento: 2 enlaces y descripción" (resumen de lo que cambia en esa nota). Una escritura y una versión por nota aunque tenga varios arreglos.
- NUNCA `noteSave`.
- `note-locked` tumba el lote ENTERO: ante ese error, pedir el resumen de esas notas, quitar las protegidas y reintentar una vez.
- Si la nota cambió desde la lectura: no se escribe y la fila lo dice; nunca copias de conflicto.

## Lo que nunca hace

Nunca borra, mueve, renombra ni crea notas o carpetas (el paquete no contiene `noteTrash`, `fileTrash`, `folderTrashEmpty`, `noteMove`, `folderRename`, `folderMove`, `folderCreate`, `noteCreate` ni `noteSave`). Nunca toca la numeración JD. Nunca escribe sin vista previa. Nunca toca una nota protegida. En un espacio compartido solo avisa (hoy los plugins no ven espacios).

## Diseño de la pestaña (7 ejes)

Solo variables CSS de Hebra, claro y oscuro. Estados: vacío ("No hay nada que arreglar"), recorriendo, cancelado, error de lectura ("No se pudo leer la biblioteca. Reintentar"), resultados, aplicando, aplicado con avisos. Casilla marcada, sin marcar, deshabilitada. Fila pendiente, hecho, no aplicado con motivo. Una columna; en estrecho la vista previa antes/después se apila. Casillas nativas con etiqueta, secciones como encabezados, recuentos en texto, estado no solo en color, el botón Aplicar dice cuántos cambios, foco al resumen tras aplicar.

## Criterios de aceptación (tests con el host falso)

1. `[[Plan viejo]]` cuya nota se renombró a "Plan 2027" en este dispositivo sale marcado; al aplicar queda `[[Plan 2027]]` y nada más cambia.
2. `[[Cancion]]` con una sola "Canción" sale marcado; con "Canción" en dos carpetas sale sin marcar con los dos candidatos, y al elegir uno se escribe `[[Carpeta/Canción|Cancion]]` y resuelve a una sola nota.
3. `[[11.01 Viajes]]` sin destino y una nota "11.05 Viajes" sale SIN marcar.
4. `[[Nota vieja#Sección|texto]]` y `![[Nota vieja]]` conservan `#Sección`, alias y `!`.
5. Un enlace a una nota que existe no sale nunca, aunque el encabezado no exista.
6. `[[Nota inexistente]]` en bloque de código, código en línea, frontmatter, etiqueta HTML o `%%...%%` no sale.
7. `[[#Encabezado]]`, `[[task:...]]`, `[[{{today}}]]` y `[texto](Nota.md)` no salen.
8. Un enlace a una nota ARCHIVADA no sale como roto.
9. Una nota protegida no se lee ni se propone; si se protege entre la revisión y Aplicar, su fila acaba en "Protegida: no se tocó" y el resto del lote se escribe.
10. Si una nota cambia entre la revisión y Aplicar, no se escribe, no aparece copia de conflicto y la fila dice que cambió.
11. (en la app) Cada nota cambiada tiene una versión nueva con causa "Mantenimiento: ...".
12. Dos arreglos en la misma nota producen UNA escritura y UNA versión.
13. Una copia de conflicto no se ofrece como destino marcado ni sale en "Sin descripción".
14. Un `[[Título]]` cuyo destino tiene copia de conflicto sale ambiguo, con la copia etiquetada "copia de conflicto".
15. Nota sin `descripcion` con primer párrafo "Esto es *una* prueba con [[Enlace|alias]]." propone "Esto es una prueba con alias.", sin marcar; al aplicar, `markdown.frontmatter` del cuerpo nuevo devuelve esa `descripcion` exacta, también con `:` o comillas.
16. Nota con `jd:` en el frontmatter y `descripcion: ""` no sale en "Sin descripción".
17. Nota sin párrafo de prosa: "Sin propuesta" y sin casilla.
18. Hermanas "Proyectos" y "proyectos " salen duplicadas; "40 Audits" en dos IDs no; "11.01 Viajes" y "11.02 Viajes" no.
19. "Sin enlaces entrantes" coincide con los enlaces entrantes de Hebra en una biblioteca de 50 notas con enlaces por título, por id, con ruta y ambiguos.
20 a 22. (P2, hechos.)
23. El paquete no contiene las llamadas prohibidas (hecho en P1).
