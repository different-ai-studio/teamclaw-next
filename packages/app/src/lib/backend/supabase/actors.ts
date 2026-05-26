import { toBackendError } from "../errors";
import { supabase as defaultSupabase } from "./client";
import type { ActorDirectoryEntry, ActorsBackend, ConnectedAgentRow } from "../types";

type RpcResult = Promise<{ data: unknown; error: unknown | null }>;
type QueryResult<T> = Promise<{ data: T; error: unknown | null }>;

type SupabaseActorsClient = {
  rpc(name: string, args: Record<string, unknown>): RpcResult;
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: unknown): {
        order(
          column: string,
          options?: { ascending?: boolean; nullsFirst?: boolean },
        ): unknown;
      } & QueryResult<ActorDirectoryEntry[]>;
    };
  };
};

type ConnectedAgentRpcRow = ConnectedAgentRow & {
  agent_id?: string | null;
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
  };
}
