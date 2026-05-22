import { describe, expect, it, vi } from "vitest";

import { createActorsApi } from "../features/actors/actor-api";
import type { Actor } from "../features/actors/actor-types";

describe("createActorsApi", () => {
  it("removeActor calls the remove_team_actor RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const api = createActorsApi({ from: vi.fn(), rpc } as any);

    await api.removeActor("actor-1");

    expect(rpc).toHaveBeenCalledWith("remove_team_actor", {
      p_actor_id: "actor-1",
    });
  });

  it("removeActor throws RPC errors", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "requires owner or admin" },
    });
    const api = createActorsApi({ from: vi.fn(), rpc } as any);

    await expect(api.removeActor("actor-1")).rejects.toThrow(
      "requires owner or admin",
    );
  });

  it("updateAgentDefaults calls the four-argument RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const api = createActorsApi({ from: vi.fn(), rpc } as any);

    await api.updateAgentDefaults("agent-1", {
      defaultWorkspaceId: "workspace-1",
      defaultAgentType: "codex",
    });

    expect(rpc).toHaveBeenCalledWith("update_agent_defaults", {
      p_agent_id: "agent-1",
      p_default_workspace_id: "workspace-1",
      p_agent_kind: null,
      p_default_agent_type: "codex",
    });
  });

  it("createReinvite calls create_team_invite for the target actor", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ token: "tok-1", expires_at: "2026-05-29T00:00:00.000Z" }],
      error: null,
    });
    const api = createActorsApi({ from: vi.fn(), rpc } as any);
    const actor: Actor = {
      actorId: "agent-1",
      teamId: "team-1",
      actorType: "agent",
      displayName: "Claude",
      role: null,
      lastActiveAt: null,
      avatarUrl: null,
      agentTypes: ["claude"],
      defaultAgentType: "claude",
      defaultWorkspaceId: "workspace-1",
      agentKind: "claude",
    };

    await expect(
      api.createReinvite({
        teamId: "team-1",
        actor,
        ttlSeconds: 60,
      }),
    ).resolves.toEqual({
      token: "tok-1",
      deeplink: "teamclaw://invite/tok-1",
      expiresAt: "2026-05-29T00:00:00.000Z",
    });
    expect(rpc).toHaveBeenCalledWith("create_team_invite", {
      p_team_id: "team-1",
      p_kind: "agent",
      p_display_name: "Claude",
      p_team_role: null,
      p_agent_kind: "daemon",
      p_ttl_seconds: 60,
      p_target_actor_id: "agent-1",
    });
  });
});
