import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseSessionsBackend } from "../sessions";

const sessionRow = (overrides: Partial<{
  id: string;
  title: string;
  team_id: string;
  mode: string | null;
  primary_agent_id: string | null;
  idea_id: string | null;
  summary: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  created_by_actor_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  has_unread: boolean | null;
}> = {}) => ({
  id: "session-1",
  title: "Session",
  team_id: "team-1",
  mode: "collab",
  primary_agent_id: "agent-1",
  idea_id: null,
  summary: "Session summary",
  last_message_at: "2026-05-17T08:00:00.000Z",
  last_message_preview: "preview",
  created_by_actor_id: "actor-1",
  created_at: "2026-05-17T07:59:00.000Z",
  updated_at: "2026-05-17T08:00:01.000Z",
  has_unread: false,
  ...overrides,
});

describe("Supabase sessions backend", () => {
  let client: {
    rpc: ReturnType<typeof vi.fn>;
    from: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    client = {
      rpc: vi.fn(),
      from: vi.fn(),
    };
  });

  it("lists current actor sessions through the RPC and maps rows", async () => {
    client.rpc.mockResolvedValueOnce({
      data: [sessionRow({ mode: null, has_unread: null })],
      error: null,
    });

    const result = await createSupabaseSessionsBackend(client).listCurrentActorSessions({
      limit: 25,
      cursor: {
        lastMessageAt: "2026-05-17T08:00:00.000Z",
        createdAt: "2026-05-17T07:59:00.000Z",
        id: "session-1",
      },
    });

    expect(client.rpc).toHaveBeenCalledWith("list_current_actor_sessions", {
      p_limit: 25,
      p_before_last_message_at: "2026-05-17T08:00:00.000Z",
      p_before_created_at: "2026-05-17T07:59:00.000Z",
      p_before_id: "session-1",
    });
    expect(result.rows[0]).toMatchObject({
      id: "session-1",
      mode: "solo",
      has_unread: false,
    });
  });

  it("creates a session shell and dedupes initial participants", async () => {
    const sessionsInsert = vi.fn().mockResolvedValueOnce({ error: null });
    const participantsInsert = vi.fn().mockResolvedValueOnce({ error: null });
    client.from.mockImplementation((table: string) => {
      if (table === "sessions") return { insert: sessionsInsert };
      if (table === "session_participants") return { insert: participantsInsert };
      throw new Error(`unexpected table ${table}`);
    });

    const result = await createSupabaseSessionsBackend(client).createSessionShell({
      id: "session-1",
      teamId: "team-1",
      createdByActorId: "actor-1",
      title: "Session",
      additionalActorIds: ["actor-2", "actor-1"],
      ideaId: "idea-1",
    });

    expect(client.from).toHaveBeenCalledWith("sessions");
    expect(sessionsInsert).toHaveBeenCalledWith({
      id: "session-1",
      team_id: "team-1",
      created_by_actor_id: "actor-1",
      mode: "collab",
      title: "Session",
      idea_id: "idea-1",
    });
    expect(participantsInsert).toHaveBeenCalledWith([
      { session_id: "session-1", actor_id: "actor-1" },
      { session_id: "session-1", actor_id: "actor-2" },
    ]);
    expect(result).toEqual({ sessionId: "session-1" });
  });

  it("marks the current actor session viewed", async () => {
    client.rpc.mockResolvedValueOnce({ data: null, error: null });

    await createSupabaseSessionsBackend(client).markCurrentActorSessionViewed("session-1", "message-1");

    expect(client.rpc).toHaveBeenCalledWith("mark_current_actor_session_viewed", {
      p_session_id: "session-1",
      p_last_read_message_id: "message-1",
    });
  });

  it("upserts added participants with the session and actor conflict target", async () => {
    const upsert = vi.fn().mockResolvedValueOnce({ error: null });
    client.from.mockReturnValueOnce({ upsert });

    await createSupabaseSessionsBackend(client).addParticipants("session-1", ["actor-1", "actor-2"]);

    expect(client.from).toHaveBeenCalledWith("session_participants");
    expect(upsert).toHaveBeenCalledWith(
      [
        { session_id: "session-1", actor_id: "actor-1" },
        { session_id: "session-1", actor_id: "actor-2" },
      ],
      { onConflict: "session_id,actor_id" },
    );
  });

  it("updates a session title", async () => {
    const eq = vi.fn().mockResolvedValueOnce({ error: null });
    const update = vi.fn(() => ({ eq }));
    client.from.mockReturnValueOnce({ update });

    await createSupabaseSessionsBackend(client).updateSessionTitle("session-1", "Renamed");

    expect(client.from).toHaveBeenCalledWith("sessions");
    expect(update).toHaveBeenCalledWith({ title: "Renamed" });
    expect(eq).toHaveBeenCalledWith("id", "session-1");
  });

  it("archives a session", async () => {
    const eq = vi.fn().mockResolvedValueOnce({ error: null });
    const update = vi.fn(() => ({ eq }));
    client.from.mockReturnValueOnce({ update });

    await createSupabaseSessionsBackend(client).archiveSession(
      "session-1",
      "2026-05-17T08:00:00.000Z",
    );

    expect(update).toHaveBeenCalledWith({ archived_at: "2026-05-17T08:00:00.000Z" });
    expect(eq).toHaveBeenCalledWith("id", "session-1");
  });

  it("gets session participants", async () => {
    const eq = vi.fn().mockResolvedValueOnce({
      data: [{ session_id: "session-1", actor_id: "actor-1", role: "owner" }],
      error: null,
    });
    const select = vi.fn(() => ({ eq }));
    client.from.mockReturnValueOnce({ select });

    const result = await createSupabaseSessionsBackend(client).getSessionParticipants("session-1");

    expect(client.from).toHaveBeenCalledWith("session_participants");
    expect(select).toHaveBeenCalledWith("session_id, actor_id, role");
    expect(eq).toHaveBeenCalledWith("session_id", "session-1");
    expect(result).toEqual([{ session_id: "session-1", actor_id: "actor-1", role: "owner" }]);
  });

  it("lists team sessions updated since a timestamp", async () => {
    const { has_unread: _hasUnread, ...syncRow } = sessionRow();
    const gt = vi.fn().mockResolvedValueOnce({
      data: [syncRow],
      error: null,
    });
    const eq = vi.fn(() => ({ gt }));
    const select = vi.fn(() => ({ eq }));
    client.from.mockReturnValueOnce({ select });

    const result = await createSupabaseSessionsBackend(client).listSessionsForTeamSince(
      "team-1",
      "2026-05-17T00:00:00.000Z",
    );

    expect(client.from).toHaveBeenCalledWith("sessions");
    expect(select).toHaveBeenCalledWith(
      "id, team_id, title, mode, primary_agent_id, idea_id, summary, last_message_preview, last_message_at, created_by_actor_id, created_at, updated_at",
    );
    expect(eq).toHaveBeenCalledWith("team_id", "team-1");
    expect(gt).toHaveBeenCalledWith("updated_at", "2026-05-17T00:00:00.000Z");
    expect(result[0]).toEqual({
      id: "session-1",
      title: "Session",
      team_id: "team-1",
      mode: "collab",
      primary_agent_id: "agent-1",
      idea_id: null,
      summary: "Session summary",
      last_message_at: "2026-05-17T08:00:00.000Z",
      last_message_preview: "preview",
      created_by_actor_id: "actor-1",
      created_at: "2026-05-17T07:59:00.000Z",
      updated_at: "2026-05-17T08:00:01.000Z",
    });
  });
});
