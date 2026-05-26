import { describe, expect, it, vi } from "vitest";
import { createSupabaseTeamsBackend } from "../teams";
import { createSupabaseActorsBackend } from "../actors";

describe("Supabase teams backend", () => {
  it("renames a team through the rename_team RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { id: "team-1", name: "New Team" },
      error: null,
    });

    const result = await createSupabaseTeamsBackend({ rpc }).renameTeam("team-1", "New Team");

    expect(rpc).toHaveBeenCalledWith("rename_team", {
      p_team_id: "team-1",
      p_name: "New Team",
    });
    expect(result).toEqual({ id: "team-1", name: "New Team" });
  });

  it("creates a member team invite through create_team_invite", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { token: "tok", expires_at: "2026-05-26T02:00:00.000Z", deeplink: "teamclaw://invite?token=tok" },
      error: null,
    });

    const result = await createSupabaseTeamsBackend({ rpc }).createTeamInvite({
      teamId: "team-1",
      actorType: "member",
      displayName: "Ada",
      teamRole: "member",
      ttlSeconds: null,
      targetActorId: null,
    });

    expect(rpc).toHaveBeenCalledWith("create_team_invite", {
      p_team_id: "team-1",
      p_kind: "member",
      p_display_name: "Ada",
      p_team_role: "member",
      p_agent_kind: null,
      p_ttl_seconds: null,
      p_target_actor_id: null,
    });
    expect(result).toEqual({
      token: "tok",
      inviteUrl: "teamclaw://invite?token=tok",
      deeplink: "teamclaw://invite?token=tok",
      expiresAt: "2026-05-26T02:00:00.000Z",
      actorId: null,
    });
  });

  it("creates an agent team invite through create_team_invite", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { token: "agent-tok", deeplink: "teamclaw://invite?token=agent-tok" },
      error: null,
    });

    await createSupabaseTeamsBackend({ rpc }).createTeamInvite({
      teamId: "team-1",
      kind: "agent",
      displayName: "Agent",
      agentKind: "daemon",
      ttlSeconds: 604800,
    });

    expect(rpc).toHaveBeenCalledWith("create_team_invite", {
      p_team_id: "team-1",
      p_kind: "agent",
      p_display_name: "Agent",
      p_team_role: null,
      p_agent_kind: "daemon",
      p_ttl_seconds: 604800,
      p_target_actor_id: null,
    });
  });
});

describe("Supabase actors backend", () => {
  it("lists actor directory rows from the actor_directory view", async () => {
    const orderDisplayName = vi.fn().mockResolvedValue({
      data: [{
        id: "actor-1",
        team_id: "team-1",
        actor_type: "member",
        display_name: "Ada",
        team_role: "admin",
        member_status: "active",
        agent_status: null,
        last_active_at: "2026-05-26T01:00:00.000Z",
      }],
      error: null,
    });
    const orderLastActive = vi.fn(() => ({ order: orderDisplayName }));
    const eq = vi.fn(() => ({ order: orderLastActive }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));

    const result = await createSupabaseActorsBackend({ from, rpc: vi.fn() }).listActorDirectory("team-1");

    expect(from).toHaveBeenCalledWith("actor_directory");
    expect(select).toHaveBeenCalledWith(
      "id, team_id, actor_type, user_id, display_name, avatar_url, team_role, member_status, agent_status, agent_types, default_agent_type, default_workspace_id, last_active_at, created_at, updated_at",
    );
    expect(eq).toHaveBeenCalledWith("team_id", "team-1");
    expect(orderLastActive).toHaveBeenCalledWith("last_active_at", { ascending: false, nullsFirst: false });
    expect(orderDisplayName).toHaveBeenCalledWith("display_name", { ascending: true });
    expect(result[0]).toMatchObject({
      id: "actor-1",
      team_id: "team-1",
      display_name: "Ada",
      team_role: "admin",
    });
  });

  it("normalizes connected agent rows and drops rows without an agent id", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        { agent_id: "agent-1", display_name: "Agent", device_id: "device-1" },
        { display_name: "Missing id" },
      ],
      error: null,
    });

    const result = await createSupabaseActorsBackend({ rpc }).listConnectedAgents("team-1");

    expect(rpc).toHaveBeenCalledWith("list_connected_agents", { p_team_id: "team-1" });
    expect(result).toEqual([
      {
        agent_id: "agent-1",
        id: "agent-1",
        team_id: "team-1",
        actor_type: "agent",
        display_name: "Agent",
        device_id: "device-1",
      },
    ]);
  });

  it("updates owned agent profile through update_owned_agent_profile", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });

    await createSupabaseActorsBackend({ rpc }).updateOwnedAgentProfile({
      agentId: "agent-1",
      displayName: "Agent",
      visibility: "team",
    });

    expect(rpc).toHaveBeenCalledWith("update_owned_agent_profile", {
      p_agent_id: "agent-1",
      p_display_name: "Agent",
      p_visibility: "team",
    });
  });

  it("updates agent defaults through update_agent_defaults", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });

    await createSupabaseActorsBackend({ rpc }).updateAgentDefaults({
      agentId: "agent-1",
      defaultWorkspaceId: "workspace-1",
      agentKind: null,
      defaultAgentType: "codex",
    });

    expect(rpc).toHaveBeenCalledWith("update_agent_defaults", {
      p_agent_id: "agent-1",
      p_default_workspace_id: "workspace-1",
      p_agent_kind: null,
      p_default_agent_type: "codex",
    });
  });
});
