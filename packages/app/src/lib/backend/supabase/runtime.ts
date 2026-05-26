import { toBackendError } from "../errors";
import { supabase as defaultSupabase } from "./client";
import type {
  AgentDefaultRow,
  AgentRuntimeHintRow,
  DaemonRuntimeBackendRow,
  RuntimeBackend,
  RuntimeTargetRow,
  SessionRuntimeModelRow,
} from "../types";

type QueryResult<T> = Promise<{ data: T; error: unknown | null }>;

type SupabaseRuntimeClient = {
  from(table: string): any;
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
    async listSessionRuntimeModels(sessionId: string) {
      assertSupabaseClient(supabase);
      const query = supabase
        .from("agent_runtimes")
        .select("runtime_id, backend_type, current_model, updated_at")
        .eq("session_id", sessionId) as {
        order(column: string, options: { ascending: boolean }): QueryResult<SessionRuntimeModelRow[]>;
      };
      const { data, error } = await query.order("updated_at", { ascending: false });
      if (error) throw toBackendError(error, "runtime.listSessionRuntimeModels");
      return data ?? [];
    },
    async listRuntimeTargetsForSession(sessionId: string, agentActorIds: string[]) {
      assertSupabaseClient(supabase);
      const query = supabase
        .from("agent_runtimes")
        .select("agent_id, runtime_id")
        .eq("session_id", sessionId) as {
        in(column: string, values: string[]): QueryResult<RuntimeTargetRow[]>;
        then: QueryResult<RuntimeTargetRow[]>["then"];
      };
      const { data, error } = agentActorIds.length > 0
        ? await query.in("agent_id", agentActorIds)
        : await query;
      if (error) throw toBackendError(error, "runtime.listRuntimeTargetsForSession");
      return data ?? [];
    },
    async listDaemonRuntimes(teamId: string) {
      assertSupabaseClient(supabase);
      const query = supabase
        .from("agent_runtimes")
        .select("id, runtime_id, team_id, agent_id, session_id, workspace_id, backend_type, backend_session_id, status, current_model, last_seen_at, created_at, updated_at")
        .eq("team_id", teamId) as {
        order(column: string, options: { ascending: boolean }): QueryResult<DaemonRuntimeBackendRow[]>;
      };
      const { data, error } = await query.order("updated_at", { ascending: false });
      if (error) throw toBackendError(error, "runtime.listDaemonRuntimes");
      return data ?? [];
    },
  };
}
