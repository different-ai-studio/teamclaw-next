import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  AgentAuthorizedHuman,
  ConnectedAgent,
} from "./connected-agent-types";

function mapAgent(row: Record<string, unknown>): ConnectedAgent {
  const rawTypes = row.agent_types;
  return {
    agentId: String(row.agent_id ?? ""),
    displayName: String(row.display_name ?? ""),
    agentTypes: Array.isArray(rawTypes) ? rawTypes.filter((t): t is string => typeof t === "string") : [],
    defaultAgentType: row.default_agent_type != null ? String(row.default_agent_type) : null,
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
  grantAuthorizedHuman: (
    agentId: string,
    memberId: string,
    permissionLevel: string,
    grantedByMemberId: string,
  ) => Promise<void>;
  revokeAuthorizedHuman: (agentId: string, memberId: string) => Promise<void>;
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
      const accessResult = (await client
        .from("agent_member_access")
        .select("member_id, permission_level, granted_by_member_id")
        .eq("agent_id", agentId)) as {
        data:
          | Array<{
              member_id: string;
              permission_level: string | null;
              granted_by_member_id: string | null;
            }>
          | null;
        error: { message?: string } | null;
      };
      if (accessResult.error) {
        throw new Error(accessResult.error.message ?? "Couldn't load authorized members.");
      }

      const accessRows = accessResult.data ?? [];
      const memberIds = accessRows.map((row) => row.member_id);
      if (memberIds.length === 0) return [];

      const actorResult = (await client
        .from("actors")
        .select("id, actor_type, display_name, last_active_at")
        .in("id", memberIds)) as {
        data:
          | Array<{
              id: string;
              actor_type: string | null;
              display_name: string | null;
              last_active_at: string | null;
            }>
          | null;
        error: { message?: string } | null;
      };
      if (actorResult.error) {
        throw new Error(actorResult.error.message ?? "Couldn't load authorized members.");
      }

      const actorsById = new Map(
        (actorResult.data ?? []).map((row) => [row.id, row]),
      );
      return accessRows.flatMap((row) => {
        const actor = actorsById.get(row.member_id);
        if (!actor || actor.actor_type !== "member") return [];
        return {
          id: row.member_id,
          displayName: actor.display_name?.trim() || "Unnamed",
          permissionLevel: row.permission_level ?? "prompt",
          grantedByActorId: row.granted_by_member_id ?? null,
          lastActiveAt: actor.last_active_at ?? null,
        };
      });
    },
    async grantAuthorizedHuman(agentId, memberId, permissionLevel, grantedByMemberId) {
      const result = await client.from("agent_member_access").upsert(
        {
          agent_id: agentId,
          member_id: memberId,
          permission_level: permissionLevel,
          granted_by_member_id: grantedByMemberId,
        },
        { onConflict: "agent_id,member_id" },
      );
      if (result.error) {
        throw new Error(result.error.message ?? "Couldn't authorize member.");
      }
    },
    async revokeAuthorizedHuman(agentId, memberId) {
      const result = await client
        .from("agent_member_access")
        .delete()
        .eq("agent_id", agentId)
        .eq("member_id", memberId);
      if (result.error) {
        throw new Error(result.error.message ?? "Couldn't revoke member.");
      }
    },
  };
}
