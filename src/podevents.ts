/**
 * Deciding when the pod list's Event column may publish a new map.
 *
 * Swapping that map rebuilds every display row — the row cache keys on the
 * map's identity — so on a 24k-pod list a poll that republished every tick
 * would be a steady-state performance regression, which is exactly the trap
 * the CPU/MEM stats poll is built to avoid. So a sweep publishes only when the
 * warnings actually differ.
 *
 * The signature is sorted because the API server returns events in whatever
 * order its watch cache holds them: without the sort, two identical sweeps
 * would look different and republish on every tick.
 */
export type PodEventLike = { key: string; reason: string; count: number };

export function podEventSignature(evs: readonly PodEventLike[]): string {
  return evs
    .map((e) => `${e.key}|${e.reason}|${e.count}`)
    .sort()
    .join(",");
}

/**
 * Whether this sweep is worth publishing. `prev` is the last published
 * signature, `hasMap` whether a map is on screen at all — the first sweep of
 * an all-clear cluster still has to publish, or the column never appears.
 */
export function shouldPublishEvents(
  prev: string | undefined,
  sig: string,
  hasMap: boolean,
): boolean {
  return prev !== sig || !hasMap;
}
