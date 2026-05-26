import { toBackendError } from "../errors";
import { supabase as defaultSupabase } from "./client";
import type { DaemonWorkspaceBackendRow, WorkspacesBackend } from "../types";

const WORKSPACE_COLUMNS =
  "id, team_id, agent_id, created_by_member_id, name, path, archived, created_at, updated_at";

type QueryResult<T> = Promise<{ data: T; error: unknown | null }>;

type SupabaseWorkspacesClient = {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: unknown): unknown;
    };
    insert(row: Record<string, unknown>): {
      select(columns: string): {
        single(): QueryResult<DaemonWorkspaceBackendRow>;
      };
    };
    update(row: Record<string, unknown>): {
      eq(column: string, value: unknown): {
        select(columns: string): {
          single(): QueryResult<DaemonWorkspaceBackendRow>;
        };
      };
    };
  };
};

export function createSupabaseWorkspacesBackend(client: unknown = defaultSupabase): WorkspacesBackend {
  const supabase = client as SupabaseWorkspacesClient;

  return {
    async listWorkspacesByIds(teamId, workspaceIds) {
      if (workspaceIds.length === 0) return [];
      const query = supabase
        .from("workspaces")
        .select("id, name, path")
        .eq("team_id", teamId) as {
        in(column: string, values: string[]): QueryResult<Array<{ id: string; name: string | null; path: string | null }>>;
      };
      const { data, error } = await query.in("id", workspaceIds);
      if (error) throw toBackendError(error, "workspaces.listWorkspacesByIds");
      return data ?? [];
    },
    async listDaemonWorkspaces(teamId, agentId) {
      const query = supabase
        .from("workspaces")
        .select(WORKSPACE_COLUMNS)
        .eq("team_id", teamId) as {
        eq(column: string, value: unknown): {
          order(column: string, options: { ascending: boolean }): {
            order(column: string, options: { ascending: boolean }): QueryResult<DaemonWorkspaceBackendRow[]>;
          };
        };
      };
      const { data, error } = await query
        .eq("agent_id", agentId ?? "")
        .order("archived", { ascending: true })
        .order("updated_at", { ascending: false });
      if (error) throw toBackendError(error, "workspaces.listDaemonWorkspaces");
      return data ?? [];
    },
    async createDaemonWorkspace(input) {
      const { data, error } = await supabase
        .from("workspaces")
        .insert({
          team_id: input.teamId,
          agent_id: input.agentId,
          created_by_member_id: input.createdByMemberId,
          name: input.name,
          path: input.path,
          archived: false,
        })
        .select(WORKSPACE_COLUMNS)
        .single();
      if (error) throw toBackendError(error, "workspaces.createDaemonWorkspace");
      return data;
    },
    async updateDaemonWorkspace(input) {
      const { data, error } = await supabase
        .from("workspaces")
        .update({
          name: input.name,
          path: input.path,
          archived: input.archived,
        })
        .eq("id", input.workspaceId)
        .select(WORKSPACE_COLUMNS)
        .single();
      if (error) throw toBackendError(error, "workspaces.updateDaemonWorkspace");
      return data;
    },
  };
}
