/**
 * Distingue los cambios de notas que provoca la propia escritura de Mantenimiento de los de
 * fuera, para que «La biblioteca ha cambiado desde la revisión» no salte por lo que acabamos de
 * hacer nosotros.
 *
 * Criterio elegido: IDS escritos + VENTANA. `workspace.onNotesChange` entrega `{ids, reason}` y
 * no documenta qué `reason` pone Hebra a una reescritura por lotes (ni si llega antes o después de
 * que se resuelva `notesRewriteBatch`), así que filtrar por `reason` sería adivinar. En cambio, un
 * evento es «propio» si TODOS sus ids están en una escritura en curso o terminada hace menos de
 * `graceMs`: cubre el evento que llega antes de la respuesta y el que llega algo después. Lo que
 * cuesta: una edición ajena de esa misma nota dentro de la ventana pasa sin aviso. Es aceptable:
 * esa nota se acaba de reescribir y releer, y cualquier otra nota sigue avisando.
 */
export const OWN_WRITE_GRACE_MS = 2000;

export interface OwnWrites {
  /** Empieza una escritura sobre estos ids (antes de llamar a `notesRewriteBatch`). */
  begin(ids: readonly string[]): void;
  /** Terminó (bien o mal): los ids siguen contando como propios `graceMs` más. */
  end(ids: readonly string[]): void;
  /** ¿Son todos estos ids de una escritura nuestra reciente o en curso? */
  isOwn(ids: readonly string[]): boolean;
}

export function createOwnWrites(now: () => number = Date.now, graceMs: number = OWN_WRITE_GRACE_MS): OwnWrites {
  const inFlight = new Map<string, number>();
  const finished = new Map<string, number>();
  return {
    begin(ids) {
      for (const id of ids) inFlight.set(id, (inFlight.get(id) ?? 0) + 1);
    },
    end(ids) {
      const at = now();
      for (const id of ids) {
        const left = (inFlight.get(id) ?? 1) - 1;
        if (left <= 0) inFlight.delete(id);
        else inFlight.set(id, left);
        finished.set(id, at);
      }
    },
    isOwn(ids) {
      if (ids.length === 0) return false;
      const at = now();
      return ids.every((id) => inFlight.has(id) || at - (finished.get(id) ?? -Infinity) < graceMs);
    }
  };
}
