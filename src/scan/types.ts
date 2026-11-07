/**
 * Tipos del recorrido de la biblioteca (P2). Lo que P3 (reglas) y P4 (propuestas) leen.
 */
import type { PluginFolder, PluginMarkdown, PluginVault } from 'hebra-plugin-api/v2';

/** Lo que el recorrido usa del almacén: un `Pick` de `PluginVault` para poder envolverlo en tests. */
export type ScanVault = Pick<PluginVault, 'notesPage' | 'noteRead' | 'noteSummary' | 'foldersList'>;

/** Lo que el recorrido usa de `api.markdown` (síncrono: sale del espejo del marco). */
export type ScanMarkdown = Pick<PluginMarkdown, 'links' | 'frontmatter' | 'frontmatterRange'> & Partial<Pick<PluginMarkdown, 'setProperty'>>;

/**
 * Un enlace del cuerpo, reducido a lo que las reglas necesitan para decidir si apunta a algo
 * que existe. Sin posiciones: reescribir un enlace (P4) relee el cuerpo vivo y vuelve a pedir
 * `markdown.links`, así la caché no guarda rangos que caducan con la primera edición.
 */
export interface LinkRef {
  kind: 'wikilink' | 'embed' | 'image';
  /** Destino ya limpio (título canónico, id, nombre de fichero o hash), o `null`. */
  target: string | null;
  targetPath: string | null;
  /** La clase del destino (`note-title`, `note-path`, `note-id`, `file`, `hash`…). */
  targetKind: string;
  heading: string | null;
  blockId: string | null;
}

/**
 * LO QUE SE GUARDA POR CUERPO (decisión de P2): un DERIVADO, no el cuerpo. Los enlaces y la
 * presencia de descripción bastan para P3 (enlaces rotos, sin descripción, sin entrantes) y
 * para P4 (que relee el cuerpo vivo antes de proponer nada). Un derivado pesa unos cientos de
 * bytes por nota; el cuerpo, kilobytes, y la biblioteca de otra persona no tiene por qué
 * duplicarse en el almacenamiento del plugin. Clave: `bodySha256` (dos notas con el mismo
 * cuerpo comparten registro). `v` es `CACHE_VERSION`: si cambia cómo se deriva, la caché
 * vieja deja de valer sin migrarla.
 */
export interface NoteAnalysis {
  sha256: string;
  v: number;
  /** El frontmatter trae `descripcion`, `descripción` o `description` no vacía. */
  hasDescription: boolean;
  /** El frontmatter trae la propiedad `jd` (índices de JDex Manager). */
  hasJd: boolean;
  /** Primer párrafo limpio (≤200), o `null` si hay descripción, `jd` o no hay prosa. */
  proposedDescription: string | null;
  /** La propuesta se puede escribir sin riesgo (ensayo en seco con `setProperty`). */
  canWriteDescription: boolean;
  links: LinkRef[];
}

export interface ScannedNote {
  id: string;
  title: string;
  folderId: string;
  /** `null` si la nota está viva; la fecha si está en el archivo. */
  archivedAt: number | null;
  /** El id de la original si es una copia de conflicto. */
  conflictOf: string | null;
  /** Protegida: no se lee nunca. */
  locked: boolean;
  updatedAt: number;
  bodySha256: string;
  /** `null` si no se pudo analizar (protegida, o desapareció entre el resumen y la lectura). */
  analysis: NoteAnalysis | null;
}

export interface ScanStats {
  notes: number;
  archived: number;
  locked: number;
  /** Llamadas a `noteRead`. */
  reads: number;
  /** Notas cuyo análisis salió de la caché por `bodySha256`. */
  cacheHits: number;
}

export interface ScanResult {
  folders: PluginFolder[];
  notes: ScannedNote[];
  stats: ScanStats;
}

export type ScanPhase = 'folders' | 'listing' | 'summaries' | 'reading' | 'detecting';

/** `total` es 0 mientras no se conoce (en `listing`). */
export interface ScanProgress {
  phase: ScanPhase;
  done: number;
  total: number;
}

/** El recorrido se canceló: no hay resultado, ni parcial. */
export class ScanCancelledError extends Error {
  override readonly name = 'ScanCancelledError';
  constructor() {
    super('Revisión cancelada.');
  }
}
