import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionParticipantStore } from "./session-participant-store";

vi.mock("@/lib/local-cache", () => ({
  loadSessionParticipants: vi.fn(async (sessionId: string) => {
    if (sessionId === "s1") return [{ actorId: "a1" }, { actorId: "agent-1" }];
    return [];
  }),
  loadActorsByIds: vi.fn(async (ids: string[]) =>
    ids.map((id) => ({
      id,
      displayName: id === "agent-1" ? "Agent One" : "Alice",
      avatarUrl: null,
      actorType: id.startsWith("agent") ? "agent" : "member",
    })),
  ),
}));

vi.mock("@/lib/sync/session-participant-sync", () => ({
  syncParticipantsForSession: vi.fn(async () => 1),
}));

beforeEach(() => {
  useSessionParticipantStore.setState({
    participantsBySession: {},
    loadingBySession: {},
    errorBySession: {},
  });
  vi.clearAllMocks();
});

describe("session-participant-store", () => {
  it("loads participants from the local cache", async () => {
    await useSessionParticipantStore.getState().ensureParticipants(["s1"]);

    expect(useSessionParticipantStore.getState().participantsBySession.s1).toEqual([
      {
        actorId: "a1",
        displayName: "Alice",
        avatarUrl: null,
        isAgent: false,
      },
      {
        actorId: "agent-1",
        displayName: "Agent One",
        avatarUrl: null,
        isAgent: true,
      },
    ]);
  });

  it("invalidates cached sessions", async () => {
    await useSessionParticipantStore.getState().ensureParticipants(["s1"]);

    useSessionParticipantStore.getState().invalidateSessions(["s1"]);

    expect(useSessionParticipantStore.getState().participantsBySession.s1).toBeUndefined();
  });

  it("syncs before refreshing when team id is available", async () => {
    const sync = await import("@/lib/sync/session-participant-sync");

    await useSessionParticipantStore.getState().refreshSession("s1", "team-1");

    expect(sync.syncParticipantsForSession).toHaveBeenCalledWith("s1", "team-1", {
      full: true,
    });
    expect(useSessionParticipantStore.getState().participantsBySession.s1).toHaveLength(2);
  });
});
