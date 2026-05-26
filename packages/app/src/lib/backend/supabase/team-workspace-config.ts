import type { TeamWorkspaceConfigBackend } from "../types";
import { toBackendError } from "../errors";
import { supabase as defaultSupabase } from "./client";

type QueryResult<T = unknown> = Promise<{ data: T; error: unknown | null }>;

type SupabaseTeamWorkspaceConfigClient = {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: unknown): {
        maybeSingle(): QueryResult<Record<string, unknown> | null>;
      };
    };
    upsert(row: Record<string, unknown>): Promise<{ error: unknown | null }>;
  };
};

const CONFIG_COLUMNS = "team_id, git_url, git_branch, git_token, ai_gateway_endpoint, enabled, updated_at";

export function createSupabaseTeamWorkspaceConfigBackend(
  client: unknown = defaultSupabase,
): TeamWorkspaceConfigBackend {
  const supabase = client as SupabaseTeamWorkspaceConfigClient;

  return {
    async load(teamId) {
      const { data, error } = await supabase
        .from("team_workspace_config")
        .select(CONFIG_COLUMNS)
        .eq("team_id", teamId)
        .maybeSingle();
      if (error) throw toBackendError(error, "teamWorkspaceConfig.load");
      return data as Awaited<ReturnType<TeamWorkspaceConfigBackend["load"]>>;
    },
    async save(input) {
      const { error } = await supabase.from("team_workspace_config").upsert(input as unknown as Record<string, unknown>);
      if (error) throw toBackendError(error, "teamWorkspaceConfig.save");
    },
  };
}
