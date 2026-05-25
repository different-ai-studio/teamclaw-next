import { toBackendError } from "../errors";
import { supabase as defaultSupabase } from "./client";
import type { AgentDefaultRow, AgentRuntimeHintRow, RuntimeBackend } from "../types";

type QueryResult<T> = Promise<{ data: T; error: unknown | null }>;

type SupabaseRuntimeClient = {
  from(table: string): {
    select(columns: string): {
      in(column: string, values: string[]): unknown;
    };
    update(values: Record<string, unknown>): {
      eq(column: string, value: unknown): Promise<{ error: unknown | null }>;
    };
  };
};

function assertSupabaseClient(client: SupabaseRuntimeClient): void {
  if (typeof client.from !== "function") {
    throw new Error("runtime backend not implemented");
  }
}

export function createSupabaseRuntimeBackend(client: unknown = defaultSupabase): RuntimeBackend {
  const supabase = client as SupabaseRuntimeClient;

  return {
    async listLatestAgentRuntimeHints(teamId: string, agentActorIds: string[]) {
      assertSupabaseClient(supabase);
      if (agentActorIds.length === 0) return [];
      const query = supabase
        .from("agent_runtimes")
        .select("id, agent_id, workspace_id, backend_type, runtime_id, session_id, status, current_model, updated_at")
        .in("agent_id", agentActorIds) as {
        eq(column: string, value: unknown): {
          order(column: string, options: { ascending: boolean }): QueryResult<AgentRuntimeHintRow[]>;
        };
      };
      const { data, error } = await query
        .eq("team_id", teamId)
        .order("updated_at", { ascending: false });
      if (error) throw toBackendError(error, "runtime.listLatestAgentRuntimeHints");
      return data ?? [];
    },
    async listAgentDefaults(agentActorIds: string[]) {
      assertSupabaseClient(supabase);
      if (agentActorIds.length === 0) return [];
      const query = supabase
        .from("agents")
        .select("id, agent_types, default_agent_type")
        .in("id", agentActorIds) as QueryResult<AgentDefaultRow[]>;
      const { data, error } = await query;
      if (error) throw toBackendError(error, "runtime.listAgentDefaults");
      return data ?? [];
    },
    async updateRuntimeModel(runtimeId: string, model: string) {
      assertSupabaseClient(supabase);
      const { error } = await supabase
        .from("agent_runtimes")
        .update({ current_model: model, updated_at: new Date().toISOString() })
        .eq("id", runtimeId);
      if (error) throw toBackendError(error, "runtime.updateRuntimeModel");
    },
  };
}
