/**
 * Her heartbeat (docs/design/body.md): her self-drive. It beats because she is
 * alive, at the rhythm of her own body (`heartbeat.restingMinutes`, a gene).
 * Nothing she does and nothing outside sets, delays, skips or paces it: there is
 * no input here but her body's rhythm. Pure.
 * @module @anima/life/heartbeat
 */

/** Milliseconds per minute. */
const MIN = 60_000

/**
 * When her heart beats next.
 * @param last - when it last beat, on her clock.
 * @param restingMinutes - her resting rhythm (a gene).
 * @returns the next beat, on her clock.
 */
export function nextBeat(last: number, restingMinutes: number): number {
  return last + restingMinutes * MIN
}
