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
          agent_id: "a1", display_name: "Claude", agent_kind: "claude",
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
      agentKind: "claude",
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
});
