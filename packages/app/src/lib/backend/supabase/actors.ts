import { toBackendError } from "../errors";
import { supabase as defaultSupabase } from "./client";
import type {
  ActorDirectoryEntry,
  ActorsBackend,
  ConnectedAgentRow,
  AgentAccessBackendRow,
  TeamMemberOptionBackendRow,
} from "../types";

type RpcResult = Promise<{ data: unknown; error: unknown | null }>;
type QueryResult<T> = Promise<{ data: T; error: unknown | null }>;

type SupabaseActorsClient = {
  rpc(name: string, args: Record<string, unknown>): RpcResult;
  // Supabase's fluent query builder changes shape at each chain step; adapter
  // methods cast the final chain to the precise result type they await.
  from(table: string): any;
};

type ConnectedAgentRpcRow = ConnectedAgentRow & {
  agent_id?: string | null;
};

type AgentAccessSupabaseRow = {
  id: string;
  agent_id: string;
  member_id: string;
  permission_level: "view" | "prompt" | "admin";
  granted_by_member_id: string | null;
  created_at: string;
  updated_at: string;
};

const ACTOR_DIRECTORY_COLUMNS =
  "id, team_id, actor_type, user_id, display_name, avatar_url, team_role, member_status, agent_status, agent_types, default_agent_type, default_workspace_id, last_active_at, created_at, updated_at";

function mapConnectedAgent(row: ConnectedAgentRpcRow, teamId: string): ConnectedAgentRow | null {
  const id = row.id ?? row.agent_id;
  if (!id) return null;
  return {
    ...row,
    id,
    team_id: row.team_id ?? teamId,
    actor_type: row.actor_type ?? "agent",
    display_name: row.display_name ?? null,
    agent_id: row.agent_id ?? id,
  };
}

function ownedAgentProfileArgs(
  input: Parameters<ActorsBackend["updateOwnedAgentProfile"]>[0],
): Record<string, unknown> {
  return {
    p_agent_id: input.agentId,
    p_display_name: input.displayName ?? null,
    p_visibility: input.visibility ?? null,
  };
}

export function createSupabaseActorsBackend(client: unknown = defaultSupabase): ActorsBackend {
  const supabase = client as SupabaseActorsClient;

  return {
    async listActorDirectory(teamId) {
      const query = supabase
        .from("actor_directory")
        .select(ACTOR_DIRECTORY_COLUMNS)
        .eq("team_id", teamId) as {
        order(
          column: string,
          options?: { ascending?: boolean; nullsFirst?: boolean },
        ): {
          order(
            column: string,
            options?: { ascending?: boolean; nullsFirst?: boolean },
          ): QueryResult<ActorDirectoryEntry[]>;
        } & QueryResult<ActorDirectoryEntry[]>;
        then: QueryResult<ActorDirectoryEntry[]>["then"];
      };
      const byActivity = query.order("last_active_at", { ascending: false, nullsFirst: false });
      const finalQuery = typeof byActivity.order === "function"
        ? byActivity.order("display_name", { ascending: true })
        : byActivity;
      const { data, error } = await finalQuery;
      if (error) throw toBackendError(error, "actors.listActorDirectory");
      return data ?? [];
    },
    async listActorDirectoryByIds(actorIds) {
      if (actorIds.length === 0) return [];
      const listQuery = supabase
        .from("actor_directory")
        .select(ACTOR_DIRECTORY_COLUMNS)
        .in("id", actorIds) as QueryResult<ActorDirectoryEntry[]>;
      const { data, error } = await listQuery;
      if (error) throw toBackendError(error, "actors.listActorDirectoryByIds");
      return data ?? [];
    },
    async getActorDirectoryEntry(actorId) {
      const query = supabase
        .from("actor_directory")
        .select(ACTOR_DIRECTORY_COLUMNS)
        .eq("id", actorId) as {
        maybeSingle(): QueryResult<ActorDirectoryEntry | null>;
      };
      const { data, error } = await query.maybeSingle();
      if (error) throw toBackendError(error, "actors.getActorDirectoryEntry");
      return data ?? null;
    },
    async getDaemonAgentDirectoryEntry(teamId, agentId) {
      const query = supabase
        .from("actor_directory")
        .select(ACTOR_DIRECTORY_COLUMNS)
        .eq("team_id", teamId)
        .eq("id", agentId) as {
        maybeSingle(): QueryResult<ActorDirectoryEntry | null>;
      };
      const { data, error } = await query.maybeSingle();
      if (error) throw toBackendError(error, "actors.getDaemonAgentDirectoryEntry");
      return data ?? null;
    },
    async listConnectedAgents(teamId) {
      const { data, error } = await supabase.rpc("list_connected_agents", { p_team_id: teamId });
      if (error) throw toBackendError(error, "actors.listConnectedAgents");
      return ((data ?? []) as ConnectedAgentRpcRow[])
        .map((row) => mapConnectedAgent(row, teamId))
        .filter((row): row is ConnectedAgentRow => row !== null);
    },
    async updateOwnedAgentProfile(input) {
      const { error } = await supabase.rpc("update_owned_agent_profile", ownedAgentProfileArgs(input));
      if (error) throw toBackendError(error, "actors.updateOwnedAgentProfile");
    },
    async updateAgentDefaults(input) {
      const { error } = await supabase.rpc("update_agent_defaults", {
        p_agent_id: input.agentId,
        p_default_workspace_id: input.defaultWorkspaceId ?? null,
        p_agent_kind: input.agentKind ?? null,
        p_default_agent_type: input.defaultAgentType ?? null,
      });
      if (error) throw toBackendError(error, "actors.updateAgentDefaults");
    },
    async listAgentAccess(agentId) {
      const accessQuery = supabase
        .from("agent_member_access")
        .select("id, agent_id, member_id, permission_level, granted_by_member_id, created_at, updated_at")
        .eq("agent_id", agentId) as {
        order(column: string, options?: { ascending?: boolean }): QueryResult<AgentAccessSupabaseRow[]>;
      };
      const { data, error } = await accessQuery.order("permission_level", { ascending: true });
      if (error) throw toBackendError(error, "actors.listAgentAccess");

      const rows = data ?? [];
      const memberIds = [...new Set(rows.map((row) => row.member_id))];
      const memberNames = new Map<string, string>();
      if (memberIds.length > 0) {
        const memberQuery = supabase
          .from("actor_directory")
          .select("id, display_name")
          .in("id", memberIds) as QueryResult<Array<{ id: string; display_name: string | null }>>;
        const { data: members, error: memberError } = await memberQuery;
        if (memberError) throw toBackendError(memberError, "actors.listAgentAccessMembers");
        for (const member of members ?? []) {
          memberNames.set(member.id, member.display_name || member.id);
        }
      }

      return rows.map((row): AgentAccessBackendRow => ({
        id: row.id,
        agentId: row.agent_id,
        memberId: row.member_id,
        memberName: memberNames.get(row.member_id) ?? row.member_id,
        permissionLevel: row.permission_level,
        grantedByMemberId: row.granted_by_member_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },
    async listTeamMembersForAccess(teamId) {
      const query = supabase
        .from("actor_directory")
        .select("id, display_name, team_role")
        .eq("team_id", teamId) as {
        eq(column: string, value: unknown): {
          order(column: string, options?: { ascending?: boolean }): QueryResult<Array<{ id: string; display_name: string | null; team_role: string | null }>>;
        };
      };
      const { data, error } = await query
        .eq("actor_type", "member")
        .order("display_name", { ascending: true });
      if (error) throw toBackendError(error, "actors.listTeamMembersForAccess");
      return (data ?? []).map((row): TeamMemberOptionBackendRow => ({
        id: row.id,
        displayName: row.display_name || row.id,
        role: row.team_role ?? null,
      }));
    },
    async upsertAgentAccess(input) {
      const { error } = await supabase
        .from("agent_member_access")
        .upsert({
          agent_id: input.agentId,
          member_id: input.memberId,
          permission_level: input.permissionLevel,
          granted_by_member_id: input.grantedByMemberId,
        }, { onConflict: "agent_id,member_id" });
      if (error) throw toBackendError(error, "actors.upsertAgentAccess");
    },
    async removeAgentAccess(accessId) {
      const { error } = await supabase
        .from("agent_member_access")
        .delete()
        .eq("id", accessId);
      if (error) throw toBackendError(error, "actors.removeAgentAccess");
    },
  };
}
