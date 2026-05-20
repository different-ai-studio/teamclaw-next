export type ActorType = "member" | "agent" | "external";

export type Actor = {
  actorId: string;
  teamId: string;
  actorType: ActorType;
  displayName: string;
  role: string | null;
  lastActiveAt: string | null;
  avatarUrl: string | null;
  /** "claude" | "opencode" | "codex" | … — only set when actorType === "agent". */
  agentKind: string | null;
};

export type ActorsListState = {
  status: "idle" | "loading" | "error" | "ready";
  actors: Actor[];
  isLoading: boolean;
  isRefreshing: boolean;
  errorMessage: string | null;
};

export const initialActorsListState: ActorsListState = {
  status: "idle",
  actors: [],
  isLoading: false,
  isRefreshing: false,
  errorMessage: null,
};

/**
 * Time window the iOS app uses to call an actor "online" — five minutes
 * since their last heartbeat. Used to drive breathing dots and online
 * counts in the Actors row.
 */
const ONLINE_WINDOW_MS = 5 * 60 * 1000;

export function isActorOnline(actor: Actor, now: number = Date.now()): boolean {
  if (!actor.lastActiveAt) return false;
  const last = Date.parse(actor.lastActiveAt);
  if (Number.isNaN(last)) return false;
  return now - last < ONLINE_WINDOW_MS;
}

export function isMemberActor(actor: Actor): boolean {
  return actor.actorType === "member";
}

export function isAgentActor(actor: Actor): boolean {
  return actor.actorType === "agent";
}
