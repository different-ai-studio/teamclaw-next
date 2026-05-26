import { describe, expect, it, vi } from "vitest";
import { createSupabaseTeamsBackend } from "../teams";
import { createSupabaseActorsBackend } from "../actors";
import { createSupabaseIdeasBackend } from "../ideas";

describe("Supabase teams backend", () => {
  it("lists current user teams through RLS-visible teams", async () => {
    const rows = [{ id: "team-1", name: "Team", slug: "team", created_at: "2026-05-26T01:00:00.000Z" }];
    const limit = vi.fn().mockResolvedValue({ data: rows, error: null });
    const order = vi.fn(() => ({ limit }));
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));

    const result = await createSupabaseTeamsBackend({ from, rpc: vi.fn() }).listCurrentUserTeams({ limit: 1 });

    expect(from).toHaveBeenCalledWith("teams");
    expect(select).toHaveBeenCalledWith("id, name, slug, created_at");
    expect(order).toHaveBeenCalledWith("created_at", { ascending: true });
    expect(limit).toHaveBeenCalledWith(1);
    expect(result).toBe(rows);
  });

  it("gets a team by id", async () => {
    const row = { id: "team-1", name: "Team", slug: "team" };
    const single = vi.fn().mockResolvedValue({ data: row, error: null });
    const eq = vi.fn(() => ({ single }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));

    const result = await createSupabaseTeamsBackend({ from, rpc: vi.fn() }).getTeam("team-1");

    expect(from).toHaveBeenCalledWith("teams");
    expect(select).toHaveBeenCalledWith("id, name, slug, created_at");
    expect(eq).toHaveBeenCalledWith("id", "team-1");
    expect(result).toBe(row);
  });

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

  it("gets one actor directory row by actor id", async () => {
    const row = { id: "actor-1", team_id: "team-1", actor_type: "member", display_name: "Ada" };
    const maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null });
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));

    const result = await createSupabaseActorsBackend({ from, rpc: vi.fn() }).getActorDirectoryEntry("actor-1");

    expect(from).toHaveBeenCalledWith("actor_directory");
    expect(select).toHaveBeenCalledWith(
      "id, team_id, actor_type, user_id, display_name, avatar_url, team_role, member_status, agent_status, agent_types, default_agent_type, default_workspace_id, last_active_at, created_at, updated_at",
    );
    expect(eq).toHaveBeenCalledWith("id", "actor-1");
    expect(result).toBe(row);
  });

  it("gets a daemon agent directory row by team and actor id with default fields", async () => {
    const row = {
      id: "agent-1",
      team_id: "team-1",
      actor_type: "agent",
      display_name: "Agent",
      agent_types: ["codex"],
      default_agent_type: "codex",
      default_workspace_id: "workspace-1",
      last_active_at: "2026-05-26T01:00:00.000Z",
    };
    const maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null });
    const eqId = vi.fn(() => ({ maybeSingle }));
    const eqTeam = vi.fn(() => ({ eq: eqId }));
    const select = vi.fn(() => ({ eq: eqTeam }));
    const from = vi.fn(() => ({ select }));

    const result = await createSupabaseActorsBackend({ from, rpc: vi.fn() }).getDaemonAgentDirectoryEntry("team-1", "agent-1");

    expect(from).toHaveBeenCalledWith("actor_directory");
    expect(select).toHaveBeenCalledWith(
      "id, team_id, actor_type, user_id, display_name, avatar_url, team_role, member_status, agent_status, agent_types, default_agent_type, default_workspace_id, last_active_at, created_at, updated_at",
    );
    expect(eqTeam).toHaveBeenCalledWith("team_id", "team-1");
    expect(eqId).toHaveBeenCalledWith("id", "agent-1");
    expect(result).toBe(row);
  });

  it("lists agent access and member names", async () => {
    const accessRows = [{
      id: "access-1",
      agent_id: "agent-1",
      member_id: "member-1",
      permission_level: "admin",
      granted_by_member_id: null,
      created_at: "2026-05-26T01:00:00.000Z",
      updated_at: "2026-05-26T01:00:00.000Z",
    }];
    const accessOrder = vi.fn().mockResolvedValue({ data: accessRows, error: null });
    const accessEq = vi.fn(() => ({ order: accessOrder }));
    const memberIn = vi.fn().mockResolvedValue({
      data: [{ id: "member-1", display_name: "Ada" }],
      error: null,
    });
    const from = vi.fn((table: string) => {
      if (table === "agent_member_access") return { select: vi.fn(() => ({ eq: accessEq })) };
      if (table === "actor_directory") return { select: vi.fn(() => ({ in: memberIn })) };
      throw new Error(`unexpected table ${table}`);
    });

    const result = await createSupabaseActorsBackend({ from, rpc: vi.fn() }).listAgentAccess("agent-1");

    expect(from).toHaveBeenCalledWith("agent_member_access");
    expect(accessEq).toHaveBeenCalledWith("agent_id", "agent-1");
    expect(accessOrder).toHaveBeenCalledWith("permission_level", { ascending: true });
    expect(memberIn).toHaveBeenCalledWith("id", ["member-1"]);
    expect(result[0]).toMatchObject({
      id: "access-1",
      agentId: "agent-1",
      memberId: "member-1",
      memberName: "Ada",
      permissionLevel: "admin",
    });
  });

  it("upserts and removes agent access", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const deleteEq = vi.fn().mockResolvedValue({ error: null });
    const deleteMock = vi.fn(() => ({ eq: deleteEq }));
    const from = vi.fn((table: string) => {
      if (table !== "agent_member_access") throw new Error(`unexpected table ${table}`);
      return { upsert, delete: deleteMock };
    });
    const backend = createSupabaseActorsBackend({ from, rpc: vi.fn() });

    await backend.upsertAgentAccess({
      agentId: "agent-1",
      memberId: "member-1",
      permissionLevel: "prompt",
      grantedByMemberId: "owner-1",
    });
    await backend.removeAgentAccess("access-1");

    expect(upsert).toHaveBeenCalledWith({
      agent_id: "agent-1",
      member_id: "member-1",
      permission_level: "prompt",
      granted_by_member_id: "owner-1",
    }, { onConflict: "agent_id,member_id" });
    expect(deleteEq).toHaveBeenCalledWith("id", "access-1");
  });
});

describe("Supabase ideas backend", () => {
  it("lists ideas from the ideas table in sidebar order", async () => {
    const orderUpdatedAt = vi.fn().mockResolvedValue({
      data: [{ id: "idea-1", team_id: "team-1", title: "Idea", sort_order: 1000 }],
      error: null,
    });
    const orderSortOrder = vi.fn(() => ({ order: orderUpdatedAt }));
    const eqArchived = vi.fn(() => ({ order: orderSortOrder }));
    const eqTeam = vi.fn(() => ({ eq: eqArchived }));
    const select = vi.fn(() => ({ eq: eqTeam }));
    const from = vi.fn(() => ({ select }));

    const result = await createSupabaseIdeasBackend({ from, rpc: vi.fn() }).listIdeas("team-1");

    expect(from).toHaveBeenCalledWith("ideas");
    expect(select).toHaveBeenCalledWith("id, title, status, created_by_actor_id, sort_order, updated_at");
    expect(eqTeam).toHaveBeenCalledWith("team_id", "team-1");
    expect(eqArchived).toHaveBeenCalledWith("archived", false);
    expect(orderSortOrder).toHaveBeenCalledWith("sort_order", { ascending: true });
    expect(orderUpdatedAt).toHaveBeenCalledWith("updated_at", { ascending: false });
    expect(result).toEqual([{ id: "idea-1", team_id: "team-1", title: "Idea", sort_order: 1000 }]);
  });

  it("loads idea detail with activities and actors", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: "idea-1",
        team_id: "team-1",
        title: "Idea",
        created_by_actor_id: "actor-1",
      },
      error: null,
    });
    const ideaEq = vi.fn(() => ({ maybeSingle }));
    const activityOrder = vi.fn().mockResolvedValue({
      data: [{ id: "activity-1", actor_id: "actor-2", activity_type: "progress", content: "Done" }],
      error: null,
    });
    const activityEq = vi.fn(() => ({ order: activityOrder }));
    const actorIn = vi.fn().mockResolvedValue({
      data: [
        { id: "actor-1", display_name: "Ada", actor_type: "member" },
        { id: "actor-2", display_name: "Agent", actor_type: "agent" },
      ],
      error: null,
    });
    const from = vi.fn((table: string) => {
      if (table === "ideas") return { select: vi.fn(() => ({ eq: ideaEq })) };
      if (table === "idea_activities") return { select: vi.fn(() => ({ eq: activityEq })) };
      return { select: vi.fn(() => ({ in: actorIn })) };
    });

    const result = await createSupabaseIdeasBackend({ from, rpc: vi.fn() }).getIdeaDetail("idea-1");

    expect(from).toHaveBeenCalledWith("ideas");
    expect(from).toHaveBeenCalledWith("idea_activities");
    expect(from).toHaveBeenCalledWith("actors");
    expect(ideaEq).toHaveBeenCalledWith("id", "idea-1");
    expect(activityEq).toHaveBeenCalledWith("idea_id", "idea-1");
    expect(activityOrder).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(actorIn).toHaveBeenCalledWith("id", ["actor-1", "actor-2"]);
    expect(result?.id).toBe("idea-1");
    expect(result?.activities).toEqual([{ id: "activity-1", actor_id: "actor-2", activity_type: "progress", content: "Done" }]);
    expect(result?.actors).toEqual([
      { id: "actor-1", display_name: "Ada", actor_type: "member" },
      { id: "actor-2", display_name: "Agent", actor_type: "agent" },
    ]);
  });

  it("creates an idea through create_idea", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { id: "idea-1", team_id: "team-1", title: "Idea", description: "Body" },
      error: null,
    });

    const result = await createSupabaseIdeasBackend({ rpc }).createIdea({
      teamId: "team-1",
      title: "Idea",
      body: "Body",
    });

    expect(rpc).toHaveBeenCalledWith("create_idea", {
      p_team_id: "team-1",
      p_title: "Idea",
      p_workspace_id: null,
      p_description: "Body",
    });
    expect(result.id).toBe("idea-1");
  });

  it("rejects malformed create_idea results before returning", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [],
      error: null,
    });

    await expect(createSupabaseIdeasBackend({ rpc }).createIdea({
      teamId: "team-1",
      title: "Idea",
    })).rejects.toMatchObject({
      operation: "ideas.createIdea",
      message: "ideas.createIdea returned malformed idea row",
    });
  });

  it("wraps Supabase errors with backend operation context", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "permission denied", status: 403 },
    });

    await expect(createSupabaseIdeasBackend({ rpc }).archiveIdea("idea-1")).rejects.toMatchObject({
      operation: "ideas.archiveIdea",
      category: "Forbidden",
      message: "permission denied",
    });
  });

  it("updates an idea through update_idea with the full edit payload", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });

    await createSupabaseIdeasBackend({ rpc }).updateIdea({
      ideaId: "idea-1",
      workspaceId: "workspace-1",
      title: "Idea",
      description: "Body",
      status: "in_progress",
    });

    expect(rpc).toHaveBeenCalledWith("update_idea", {
      p_idea_id: "idea-1",
      p_workspace_id: "workspace-1",
      p_title: "Idea",
      p_description: "Body",
      p_status: "in_progress",
    });
  });

  it("updates only sort_order through the ideas table", async () => {
    const eq = vi.fn().mockResolvedValue({ data: null, error: null });
    const update = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ update }));

    await createSupabaseIdeasBackend({ from, rpc: vi.fn() }).updateIdea({
      ideaId: "idea-1",
      sortOrder: 2000,
    });

    expect(from).toHaveBeenCalledWith("ideas");
    expect(update).toHaveBeenCalledWith({ sort_order: 2000 });
    expect(eq).toHaveBeenCalledWith("id", "idea-1");
  });

  it("rejects unsupported partial idea updates before calling Supabase", async () => {
    const rpc = vi.fn();
    const from = vi.fn();

    await expect(createSupabaseIdeasBackend({ from, rpc }).updateIdea({
      ideaId: "idea-1",
      status: "done",
    } as never)).rejects.toMatchObject({
      operation: "ideas.updateIdea",
      message: "ideas.updateIdea requires either sortOrder only or title, status, and workspaceId",
    });

    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("creates idea activity through create_idea_activity", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });

    await createSupabaseIdeasBackend({ rpc }).createIdeaActivity({
      ideaId: "idea-1",
      activityType: "progress",
      content: "Shipped",
      metadata: { source: "test" },
    });

    expect(rpc).toHaveBeenCalledWith("create_idea_activity", {
      p_idea_id: "idea-1",
      p_activity_type: "progress",
      p_content: "Shipped",
      p_metadata: { source: "test" },
    });
  });

  it("archives an idea through archive_idea", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });

    await createSupabaseIdeasBackend({ rpc }).archiveIdea("idea-1");

    expect(rpc).toHaveBeenCalledWith("archive_idea", {
      p_idea_id: "idea-1",
      p_archived: true,
    });
  });
});
