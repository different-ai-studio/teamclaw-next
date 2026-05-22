import { describe, expect, it, vi } from "vitest";

import { createAgentAccessApi } from "../features/actors/agent-access-api";
import type { SupabaseClient } from "@supabase/supabase-js";

function fakeClient(rpc: (name: string, args?: object) => Promise<{ data: unknown; error: null }>): SupabaseClient {
  return { rpc } as unknown as SupabaseClient;
}

describe("createAgentAccessApi", () => {
  it("listConnectedAgents maps snake_case rows", async () => {
    const client = fakeClient(async (_name, _args) => ({
      data: [
        {
          agent_id: "a1", display_name: "Claude",
          agent_types: ["claude", "opencode"], default_agent_type: "claude",
          permission_level: "team", visibility: "team", is_owner: true,
          device_id: "dev1", last_active_at: "2026-05-20T10:00:00.000Z",
        },
      ],
      error: null,
    }));
    const api = createAgentAccessApi(client);
    const rows = await api.listConnectedAgents("team1");
    expect(rows[0]).toEqual({
      agentId: "a1",
      displayName: "Claude",
      agentTypes: ["claude", "opencode"],
      defaultAgentType: "claude",
      permissionLevel: "team",
      visibility: "team",
      isOwner: true,
      deviceId: "dev1",
      lastActiveAt: "2026-05-20T10:00:00.000Z",
    });
  });

  it("shareAgentToTeam throws on RPC error", async () => {
    const client = fakeClient(async () => ({ data: null, error: { message: "denied" } as unknown as null }));
    const api = createAgentAccessApi(client);
    await expect(api.shareAgentToTeam("a1")).rejects.toThrow("denied");
  });

  it("listAuthorizedHumans reads access rows and maps member actors", async () => {
    const accessEq = vi.fn().mockResolvedValue({
      data: [
        {
          member_id: "m2",
          permission_level: "prompt",
          granted_by_member_id: "m1",
        },
      ],
      error: null,
    });
    const actorIn = vi.fn().mockResolvedValue({
      data: [
        {
          id: "m2",
          actor_type: "member",
          display_name: "Ada",
          last_active_at: "2026-05-20T10:00:00.000Z",
        },
      ],
      error: null,
    });
    const client = {
      rpc: vi.fn(),
      from: vi.fn((table: string) => {
        if (table === "agent_member_access") {
          return { select: vi.fn(() => ({ eq: accessEq })) };
        }
        if (table === "actors") {
          return { select: vi.fn(() => ({ in: actorIn })) };
        }
        throw new Error(`unexpected table ${table}`);
      }),
    } as unknown as SupabaseClient;

    const api = createAgentAccessApi(client);

    await expect(api.listAuthorizedHumans("agent-1")).resolves.toEqual([
      {
        id: "m2",
        displayName: "Ada",
        permissionLevel: "prompt",
        grantedByActorId: "m1",
        lastActiveAt: "2026-05-20T10:00:00.000Z",
      },
    ]);
    expect(accessEq).toHaveBeenCalledWith("agent_id", "agent-1");
    expect(actorIn).toHaveBeenCalledWith("id", ["m2"]);
  });

  it("grantAuthorizedHuman upserts the agent access row", async () => {
    const upsert = vi.fn().mockResolvedValue({ data: null, error: null });
    const client = {
      rpc: vi.fn(),
      from: vi.fn(() => ({ upsert })),
    } as unknown as SupabaseClient;
    const api = createAgentAccessApi(client);

    await api.grantAuthorizedHuman("agent-1", "m2", "prompt", "m1");

    expect(upsert).toHaveBeenCalledWith(
      {
        agent_id: "agent-1",
        member_id: "m2",
        permission_level: "prompt",
        granted_by_member_id: "m1",
      },
      { onConflict: "agent_id,member_id" },
    );
  });

  it("revokeAuthorizedHuman deletes the agent access row", async () => {
    const secondEq = vi.fn().mockResolvedValue({ data: null, error: null });
    const firstEq = vi.fn(() => ({ eq: secondEq }));
    const del = vi.fn(() => ({ eq: firstEq }));
    const client = {
      rpc: vi.fn(),
      from: vi.fn(() => ({ delete: del })),
    } as unknown as SupabaseClient;
    const api = createAgentAccessApi(client);

    await api.revokeAuthorizedHuman("agent-1", "m2");

    expect(firstEq).toHaveBeenCalledWith("agent_id", "agent-1");
    expect(secondEq).toHaveBeenCalledWith("member_id", "m2");
  });
});
