import { describe, expect, it, vi } from "vitest";
import { createSupabaseNotificationsBackend } from "../notifications";
import { createSupabaseSessionMembersBackend } from "../session-members";
import { createSupabaseShortcutsBackend } from "../shortcuts";
import { createSupabaseTeamWorkspaceConfigBackend } from "../team-workspace-config";
import { createSupabaseTelemetryBackend } from "../telemetry";
import { createSupabaseWorkspacesBackend } from "../workspaces";
import { createSupabaseSyncBackend } from "../sync";

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

describe("Supabase shortcuts backend", () => {
  it("creates shortcuts through shortcut_create", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: "shortcut-1",
      error: null,
    });

    const result = await createSupabaseShortcutsBackend({ rpc }).createShortcut({
      p_scope: "team",
      p_label: "Run",
      p_node_type: "link",
      p_team_id: "team-1",
      p_parent_id: null,
      p_icon: null,
      p_order: 0,
      p_target: "teamclaw://run",
    });

    expect(rpc).toHaveBeenCalledWith("shortcut_create", {
      p_scope: "team",
      p_label: "Run",
      p_node_type: "link",
      p_team_id: "team-1",
      p_parent_id: null,
      p_icon: null,
      p_order: 0,
      p_target: "teamclaw://run",
    });
    expect(result).toEqual({ id: "shortcut-1" });
  });

  it("rejects an empty shortcut_create id", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });

    await expect(
      createSupabaseShortcutsBackend({ rpc }).createShortcut({
        p_scope: "personal",
        p_label: "Run",
        p_node_type: "link",
        p_team_id: null,
        p_parent_id: null,
        p_icon: null,
        p_order: 0,
        p_target: "teamclaw://run",
      }),
    ).rejects.toMatchObject({ operation: "shortcuts.createShortcut" });
  });
});

describe("Supabase notifications backend", () => {
  it("mutes and unmutes sessions with session_mutes", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const deleteEqUser = vi.fn().mockResolvedValue({ error: null });
    const deleteEqSession = vi.fn().mockReturnValue({ eq: deleteEqUser });
    const from = vi.fn((table: string) => {
      if (table === "session_mutes") {
        return {
          upsert,
          delete: () => ({ eq: deleteEqSession }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    });

    const backend = createSupabaseNotificationsBackend({ from });
    await backend.setSessionMuted({ sessionId: "s1", userId: "u1", muted: true });
    await backend.setSessionMuted({ sessionId: "s1", userId: "u1", muted: false });

    expect(upsert).toHaveBeenCalledWith({ session_id: "s1", user_id: "u1" }, { onConflict: "user_id,session_id" });
    expect(deleteEqSession).toHaveBeenCalledWith("session_id", "s1");
    expect(deleteEqUser).toHaveBeenCalledWith("user_id", "u1");
  });

  it("saves notification preferences by user_id", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn((table: string) => {
      if (table === "notification_prefs") return { upsert };
      throw new Error(`unexpected table ${table}`);
    });

    await createSupabaseNotificationsBackend({ from }).savePreferences({
      user_id: "u1",
      enabled: true,
      dnd_start_min: 540,
      dnd_end_min: 1020,
      dnd_tz: "Asia/Shanghai",
      updated_at: "2026-05-26T00:00:00.000Z",
    });

    expect(from).toHaveBeenCalledWith("notification_prefs");
    expect(upsert).toHaveBeenCalledWith(
      {
        user_id: "u1",
        enabled: true,
        dnd_start_min: 540,
        dnd_end_min: 1020,
        dnd_tz: "Asia/Shanghai",
        updated_at: "2026-05-26T00:00:00.000Z",
      },
      { onConflict: "user_id" },
    );
  });
});

describe("Supabase workspaces backend", () => {
  it("lists daemon workspaces by team and agent", async () => {
    const rows = [{ id: "workspace-1", team_id: "team-1", agent_id: "agent-1", name: "Main", archived: false }];
    const orderUpdated = vi.fn().mockResolvedValue({ data: rows, error: null });
    const orderArchived = vi.fn(() => ({ order: orderUpdated }));
    const eqAgent = vi.fn(() => ({ order: orderArchived }));
    const eqTeam = vi.fn(() => ({ eq: eqAgent }));
    const select = vi.fn(() => ({ eq: eqTeam }));
    const from = vi.fn(() => ({ select }));

    const result = await createSupabaseWorkspacesBackend({ from }).listDaemonWorkspaces("team-1", "agent-1");

    expect(from).toHaveBeenCalledWith("workspaces");
    expect(select).toHaveBeenCalledWith("id, team_id, agent_id, created_by_member_id, name, path, archived, created_at, updated_at");
    expect(eqTeam).toHaveBeenCalledWith("team_id", "team-1");
    expect(eqAgent).toHaveBeenCalledWith("agent_id", "agent-1");
    expect(orderArchived).toHaveBeenCalledWith("archived", { ascending: true });
    expect(orderUpdated).toHaveBeenCalledWith("updated_at", { ascending: false });
    expect(result).toBe(rows);
  });

  it("creates and updates daemon workspaces", async () => {
    const row = { id: "workspace-1", team_id: "team-1", agent_id: "agent-1", name: "Main" };
    const insertSingle = vi.fn().mockResolvedValue({ data: row, error: null });
    const insertSelect = vi.fn(() => ({ single: insertSingle }));
    const insert = vi.fn(() => ({ select: insertSelect }));
    const updateSingle = vi.fn().mockResolvedValue({ data: row, error: null });
    const updateSelect = vi.fn(() => ({ single: updateSingle }));
    const updateEq = vi.fn(() => ({ select: updateSelect }));
    const update = vi.fn(() => ({ eq: updateEq }));
    const from = vi.fn(() => ({ insert, update }));
    const backend = createSupabaseWorkspacesBackend({ from });

    await backend.createDaemonWorkspace({
      teamId: "team-1",
      agentId: "agent-1",
      createdByMemberId: "member-1",
      name: "Main",
      path: "/repo",
    });
    await backend.updateDaemonWorkspace({
      workspaceId: "workspace-1",
      name: "Renamed",
      path: "/repo",
      archived: true,
    });

    expect(insert).toHaveBeenCalledWith({
      team_id: "team-1",
      agent_id: "agent-1",
      created_by_member_id: "member-1",
      name: "Main",
      path: "/repo",
      archived: false,
    });
    expect(update).toHaveBeenCalledWith({ name: "Renamed", path: "/repo", archived: true });
    expect(updateEq).toHaveBeenCalledWith("id", "workspace-1");
  });
});

describe("Supabase sync backend", () => {
  it("lists actor directory sync rows with a fixed select shape", async () => {
    const rows = [{ id: "row-1", updated_at: "2026-05-26T01:00:00.000Z" }];
    const gt = vi.fn().mockResolvedValue({ data: rows, error: null });
    const eq = vi.fn(() => ({ gt }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));

    const result = await createSupabaseSyncBackend({ from }).listActorDirectoryForSync("team-1", "2026-05-26T00:00:00.000Z");

    expect(from).toHaveBeenCalledWith("actor_directory");
    expect(select).toHaveBeenCalledWith("id, team_id, actor_type, display_name, member_status, agent_status, last_active_at, created_at, updated_at");
    expect(eq).toHaveBeenCalledWith("team_id", "team-1");
    expect(gt).toHaveBeenCalledWith("updated_at", "2026-05-26T00:00:00.000Z");
    expect(result).toBe(rows);
  });

  it("lists idea sync rows with a fixed select shape", async () => {
    const rows = [{ id: "idea-1", updated_at: "2026-05-26T01:00:00.000Z" }];
    const query = Promise.resolve({ data: rows, error: null });
    const eq = vi.fn(() => query);
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));

    const result = await createSupabaseSyncBackend({ from }).listIdeasForSync("team-1", null);

    expect(from).toHaveBeenCalledWith("ideas");
    expect(select).toHaveBeenCalledWith("id, team_id, workspace_id, parent_idea_id, title, description, status, created_by_actor_id, archived, sort_order, created_at, updated_at");
    expect(eq).toHaveBeenCalledWith("team_id", "team-1");
    expect(result).toBe(rows);
  });

  it("lists session participant sync rows with a fixed select shape", async () => {
    const rows = [{ id: "participant-1", updated_at: "2026-05-26T01:00:00.000Z" }];
    const gt = vi.fn().mockResolvedValue({ data: rows, error: null });
    const eq = vi.fn(() => ({ gt }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));

    const result = await createSupabaseSyncBackend({ from }).listSessionParticipantsForSync("session-1", "2026-05-26T00:00:00.000Z");

    expect(from).toHaveBeenCalledWith("session_participants");
    expect(select).toHaveBeenCalledWith("id, session_id, actor_id, joined_at, created_at, updated_at");
    expect(eq).toHaveBeenCalledWith("session_id", "session-1");
    expect(gt).toHaveBeenCalledWith("updated_at", "2026-05-26T00:00:00.000Z");
    expect(result).toBe(rows);
  });
});

describe("Supabase team workspace config backend", () => {
  it("saves workspace config with team_workspace_config upsert", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn().mockReturnValue({ upsert });

    await createSupabaseTeamWorkspaceConfigBackend({ from }).save({
      team_id: "team-1",
      git_url: "https://example.com/repo.git",
      git_branch: "main",
      git_token: null,
      ai_gateway_endpoint: null,
      enabled: true,
    });

    expect(from).toHaveBeenCalledWith("team_workspace_config");
    expect(upsert).toHaveBeenCalledWith({
      team_id: "team-1",
      git_url: "https://example.com/repo.git",
      git_branch: "main",
      git_token: null,
      ai_gateway_endpoint: null,
      enabled: true,
    });
  });
});

describe("Supabase telemetry backend", () => {
  it("inserts feedback rows", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn().mockReturnValue({ insert });

    await createSupabaseTelemetryBackend({ from }).insertFeedback({ message_id: "m1", rating: 1 });

    expect(from).toHaveBeenCalledWith("actor_message_feedback");
    expect(insert).toHaveBeenCalledWith({ message_id: "m1", rating: 1 });
  });

  it("does not expose telemetry event writes without a backing table", () => {
    const from = vi.fn();
    const backend = createSupabaseTelemetryBackend({ from }) as unknown as Record<string, unknown>;

    expect(backend.insertTelemetryEvent).toBeUndefined();
    expect(from).not.toHaveBeenCalled();
  });

  it("rejects feedback delete without required filters before deleting", async () => {
    const from = vi.fn();

    await expect(
      createSupabaseTelemetryBackend({ from }).deleteFeedback({
        actor_id: "actor-1",
        team_id: "team-1",
      } as never),
    ).rejects.toMatchObject({ operation: "telemetry.deleteFeedback" });

    expect(from).not.toHaveBeenCalled();
  });

  it("applies a null star-rating predicate when deleting thumb feedback", async () => {
    const result = Promise.resolve({ error: null });
    const is = vi.fn().mockReturnValue(result);
    const eqMessage = vi.fn().mockReturnValue({ eq: vi.fn(), is });
    const eqTeam = vi.fn().mockReturnValue({ eq: eqMessage, is });
    const eqActor = vi.fn().mockReturnValue({ eq: eqTeam, is });
    const deleteMock = vi.fn().mockReturnValue({ eq: eqActor, is });
    const from = vi.fn().mockReturnValue({ delete: deleteMock });

    await createSupabaseTelemetryBackend({ from }).deleteFeedback({
      actor_id: "actor-1",
      team_id: "team-1",
      message_id: "message-1",
      kind: "thumb",
    });

    expect(from).toHaveBeenCalledWith("actor_message_feedback");
    expect(eqActor).toHaveBeenCalledWith("actor_id", "actor-1");
    expect(eqTeam).toHaveBeenCalledWith("team_id", "team-1");
    expect(eqMessage).toHaveBeenCalledWith("message_id", "message-1");
    expect(is).toHaveBeenCalledWith("star_rating", null);
  });

  it("applies a star-rating predicate when deleting star feedback", async () => {
    const result = Promise.resolve({ error: null });
    const not = vi.fn().mockReturnValue(result);
    const eqMessage = vi.fn().mockReturnValue({ eq: vi.fn(), not });
    const eqTeam = vi.fn().mockReturnValue({ eq: eqMessage, not });
    const eqActor = vi.fn().mockReturnValue({ eq: eqTeam, not });
    const deleteMock = vi.fn().mockReturnValue({ eq: eqActor, not });
    const from = vi.fn().mockReturnValue({ delete: deleteMock });

    await createSupabaseTelemetryBackend({ from }).deleteFeedback({
      actor_id: "actor-1",
      team_id: "team-1",
      message_id: "message-1",
      kind: "star",
    });

    expect(from).toHaveBeenCalledWith("actor_message_feedback");
    expect(eqActor).toHaveBeenCalledWith("actor_id", "actor-1");
    expect(eqTeam).toHaveBeenCalledWith("team_id", "team-1");
    expect(eqMessage).toHaveBeenCalledWith("message_id", "message-1");
    expect(not).toHaveBeenCalledWith("star_rating", "is", null);
  });

  it("rejects thumb feedback delete when the query builder cannot add an is predicate", async () => {
    const eqMessage = vi.fn().mockResolvedValue({ error: null });
    const eqTeam = vi.fn().mockReturnValue({ eq: eqMessage });
    const eqActor = vi.fn().mockReturnValue({ eq: eqTeam });
    const deleteMock = vi.fn().mockReturnValue({ eq: eqActor });
    const from = vi.fn().mockReturnValue({ delete: deleteMock });

    await expect(
      createSupabaseTelemetryBackend({ from }).deleteFeedback({
        actor_id: "actor-1",
        team_id: "team-1",
        message_id: "message-1",
        kind: "thumb",
      }),
    ).rejects.toMatchObject({ operation: "telemetry.deleteFeedback" });
  });

  it("rejects star feedback delete when the query builder cannot add a not predicate", async () => {
    const eqMessage = vi.fn().mockResolvedValue({ error: null });
    const eqTeam = vi.fn().mockReturnValue({ eq: eqMessage });
    const eqActor = vi.fn().mockReturnValue({ eq: eqTeam });
    const deleteMock = vi.fn().mockReturnValue({ eq: eqActor });
    const from = vi.fn().mockReturnValue({ delete: deleteMock });

    await expect(
      createSupabaseTelemetryBackend({ from }).deleteFeedback({
        actor_id: "actor-1",
        team_id: "team-1",
        message_id: "message-1",
        kind: "star",
      }),
    ).rejects.toMatchObject({ operation: "telemetry.deleteFeedback" });
  });
});
