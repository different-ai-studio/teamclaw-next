import { describe, expect, it, vi } from "vitest";
import { createSupabaseSessionMembersBackend } from "../session-members";

describe("Supabase session members backend", () => {
  it("lists participants by session and preserves participant ordering", async () => {
    const participantEq = vi.fn().mockResolvedValue({
      data: [{ actor_id: "actor-2" }, { actor_id: "actor-1" }],
      error: null,
    });
    const actorIn = vi.fn().mockResolvedValue({
      data: [
        {
          id: "actor-1",
          team_id: "team-1",
          actor_type: "member",
          display_name: "Ada",
          member_status: "active",
          agent_status: null,
          agent_types: null,
          default_agent_type: null,
          last_active_at: null,
        },
        {
          id: "actor-2",
          team_id: "team-1",
          actor_type: "agent",
          display_name: "Reviewer",
          member_status: null,
          agent_status: "idle",
          agent_types: ["opencode"],
          default_agent_type: "opencode",
          last_active_at: "2026-05-26T01:00:00.000Z",
        },
      ],
      error: null,
    });
    const participantSelect = vi.fn().mockReturnValue({ eq: participantEq });
    const actorSelect = vi.fn().mockReturnValue({ in: actorIn });
    const from = vi.fn((table: string) => {
      if (table === "session_participants") return { select: participantSelect };
      if (table === "actor_directory") return { select: actorSelect };
      throw new Error(`unexpected table ${table}`);
    });

    const result = await createSupabaseSessionMembersBackend({ from }).listParticipants("session-1");

    expect(from).toHaveBeenCalledWith("session_participants");
    expect(participantSelect).toHaveBeenCalledWith("actor_id");
    expect(participantEq).toHaveBeenCalledWith("session_id", "session-1");
    expect(from).toHaveBeenCalledWith("actor_directory");
    expect(actorSelect).toHaveBeenCalledWith(
      "id, team_id, actor_type, user_id, display_name, avatar_url, team_role, member_status, agent_status, agent_types, default_agent_type, default_workspace_id, last_active_at, created_at, updated_at",
    );
    expect(actorIn).toHaveBeenCalledWith("id", ["actor-2", "actor-1"]);
    expect(result.map((row) => row.id)).toEqual(["actor-2", "actor-1"]);
    expect(result[0]).toMatchObject({
      id: "actor-2",
      actor_type: "agent",
      display_name: "Reviewer",
      agent_types: ["opencode"],
      default_agent_type: "opencode",
    });
  });

  it("lists candidate actors by team and filters present actors", async () => {
    const eq = vi.fn().mockResolvedValue({
      data: [
        { id: "actor-1", team_id: "team-1", actor_type: "member", display_name: "Ada" },
        { id: "actor-2", team_id: "team-1", actor_type: "agent", display_name: "Reviewer" },
        { id: "actor-3", team_id: "team-1", actor_type: "guest", display_name: "Hidden" },
      ],
      error: null,
    });
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ select });

    const result = await createSupabaseSessionMembersBackend({ from }).listCandidateActors("team-1", ["actor-1"]);

    expect(from).toHaveBeenCalledWith("actor_directory");
    expect(select).toHaveBeenCalledWith(
      "id, team_id, actor_type, user_id, display_name, avatar_url, team_role, member_status, agent_status, agent_types, default_agent_type, default_workspace_id, last_active_at, created_at, updated_at",
    );
    expect(eq).toHaveBeenCalledWith("team_id", "team-1");
    expect(result).toEqual([
      expect.objectContaining({
        id: "actor-2",
        actor_type: "agent",
        display_name: "Reviewer",
        is_present: false,
      }),
    ]);
  });

  it("lists session ids for an actor", async () => {
    const eq = vi.fn().mockResolvedValue({
      data: [{ session_id: "session-1" }, { session_id: "session-2" }],
      error: null,
    });
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ select });

    const result = await createSupabaseSessionMembersBackend({ from }).listSessionIdsForActor("actor-1");

    expect(from).toHaveBeenCalledWith("session_participants");
    expect(select).toHaveBeenCalledWith("session_id");
    expect(eq).toHaveBeenCalledWith("actor_id", "actor-1");
    expect(result).toEqual(["session-1", "session-2"]);
  });

  it("adds a participant with duplicate-tolerant upsert", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn().mockReturnValue({ upsert });

    await createSupabaseSessionMembersBackend({ from }).addParticipant("session-1", "actor-1");

    expect(from).toHaveBeenCalledWith("session_participants");
    expect(upsert).toHaveBeenCalledWith(
      { session_id: "session-1", actor_id: "actor-1" },
      { onConflict: "session_id,actor_id", ignoreDuplicates: true },
    );
  });

  it("removes a participant by session and actor id", async () => {
    const eqActor = vi.fn().mockResolvedValue({ error: null });
    const eqSession = vi.fn().mockReturnValue({ eq: eqActor });
    const deleteMock = vi.fn().mockReturnValue({ eq: eqSession });
    const from = vi.fn().mockReturnValue({ delete: deleteMock });

    await createSupabaseSessionMembersBackend({ from }).removeParticipant("session-1", "actor-1");

    expect(from).toHaveBeenCalledWith("session_participants");
    expect(deleteMock).toHaveBeenCalled();
    expect(eqSession).toHaveBeenCalledWith("session_id", "session-1");
    expect(eqActor).toHaveBeenCalledWith("actor_id", "actor-1");
  });
});
