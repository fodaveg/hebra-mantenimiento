/** `4050` -> `4.050` (es-ES agrupa desde cinco cifras en algunos motores: aquí siempre). */
export function formatCount(value: number): string {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
