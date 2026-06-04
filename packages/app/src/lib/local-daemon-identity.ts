/** Tracks amuxd re-init: previous local actor ids are "stale" for engaged pills. */

const supersededLocalActorIds = new Set<string>()
let lastKnownLocalActorId: string | null = null

export function noteLocalDaemonActorId(current: string | null): void {
  const next = current?.trim() || null
  if (next && lastKnownLocalActorId && next !== lastKnownLocalActorId) {
    supersededLocalActorIds.add(lastKnownLocalActorId)
  }
  if (next) lastKnownLocalActorId = next
}

export function isSupersededLocalAgent(agentId: string): boolean {
  return supersededLocalActorIds.has(agentId)
}

/** @internal test helper */
export function __resetLocalDaemonIdentityForTest(): void {
  supersededLocalActorIds.clear()
  lastKnownLocalActorId = null
}
