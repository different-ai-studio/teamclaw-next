import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  AgentAuthorizedHuman,
  ConnectedAgent,
} from "./connected-agent-types";

function mapAgent(row: Record<string, unknown>): ConnectedAgent {
  return {
    agentId: String(row.agent_id ?? ""),
    displayName: String(row.display_name ?? ""),
    agentKind: String(row.agent_kind ?? ""),
    permissionLevel: String(row.permission_level ?? "prompt"),
    visibility: (String(row.visibility ?? "team") as "team" | "personal"),
    isOwner: Boolean(row.is_owner),
    deviceId: row.device_id != null ? String(row.device_id) : null,
    lastActiveAt: row.last_active_at != null ? String(row.last_active_at) : null,
  };
}

export type AgentAccessApi = {
  listConnectedAgents: (teamId: string) => Promise<ConnectedAgent[]>;
  shareAgentToTeam: (agentId: string) => Promise<void>;
  makeAgentPersonal: (agentId: string) => Promise<void>;
  listAuthorizedHumans: (agentId: string) => Promise<AgentAuthorizedHuman[]>;
  grantAuthorizedHuman: (agentId: string, memberId: string, permissionLevel: string) => Promise<void>;
};

export function createAgentAccessApi(client: SupabaseClient): AgentAccessApi {
  async function callRpc(name: string, args: object): Promise<unknown> {
    const result = await client.rpc(name, args);
    if (result.error) throw new Error(result.error.message ?? "RPC failed");
    return result.data;
  }
  return {
    async listConnectedAgents(teamId) {
      const data = await callRpc("list_connected_agents", { p_team_id: teamId });
      if (!Array.isArray(data)) return [];
      return data.map((row) => mapAgent(row as Record<string, unknown>));
    },
    async shareAgentToTeam(agentId) {
      await callRpc("share_agent_to_team", { p_agent_id: agentId });
    },
    async makeAgentPersonal(agentId) {
      await callRpc("make_agent_personal", { p_agent_id: agentId });
    },
    async listAuthorizedHumans(agentId) {
      const data = await callRpc("list_authorized_humans", { p_agent_id: agentId });
      if (!Array.isArray(data)) return [];
      return data.map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          id: String(row.member_id ?? ""),
          displayName: String(row.display_name ?? ""),
          permissionLevel: String(row.permission_level ?? "prompt"),
          grantedByActorId: row.granted_by_actor_id != null ? String(row.granted_by_actor_id) : null,
          lastActiveAt: row.last_active_at != null ? String(row.last_active_at) : null,
        };
      });
    },
    async grantAuthorizedHuman(agentId, memberId, permissionLevel) {
      await callRpc("grant_authorized_human", {
        p_agent_id: agentId, p_member_id: memberId, p_permission_level: permissionLevel,
      });
    },
  };
}
