import type {
  AgentDefaultRow,
  AgentRuntimeHintRow,
  DaemonRuntimeBackendRow,
  RuntimeBackend,
  RuntimeTargetRow,
  SessionRuntimeModelRow,
} from "../types";
import type { CloudApiClient } from "./http";

type CloudAgentRuntime = {
  id: string;
  runtimeId?: string | null;
  teamId: string;
  agentId: string;
  sessionId?: string | null;
  workspaceId?: string | null;
  backendType: string;
  backendSessionId?: string | null;
  status: string;
  currentModel?: string | null;
  lastSeenAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

type CloudAgentDefault = {
  id: string;
  agentTypes?: string[] | null;
  defaultAgentType?: string | null;
};

function mapRuntime(row: CloudAgentRuntime): DaemonRuntimeBackendRow {
  return {
    id: row.id,
    runtime_id: row.runtimeId ?? null,
    team_id: row.teamId,
    agent_id: row.agentId,
    session_id: row.sessionId ?? null,
    workspace_id: row.workspaceId ?? null,
    backend_type: row.backendType,
    backend_session_id: row.backendSessionId ?? null,
    status: row.status,
    current_model: row.currentModel ?? null,
    last_seen_at: row.lastSeenAt ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

async function cloudOrDelegate<T>(
  cloud: () => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  try {
    return await cloud();
  } catch {
    return fallback();
  }
}

export function createRuntimeModule(client: CloudApiClient, delegate: RuntimeBackend): RuntimeBackend {
  return {
    ...delegate,
    async listLatestAgentRuntimeHints(teamId, agentActorIds) {
      if (agentActorIds.length === 0) return [];
      return cloudOrDelegate(
        async () => {
          const params = new URLSearchParams({ teamId });
          for (const id of agentActorIds) params.append("agentId", id);
          const out = await client.get<{ items: AgentRuntimeHintRow[] }>(`/v1/runtime/hints?${params}`);
          return out.items;
        },
        () => delegate.listLatestAgentRuntimeHints(teamId, agentActorIds),
      );
    },
    async listAgentDefaults(agentActorIds) {
      if (agentActorIds.length === 0) return [];
      return cloudOrDelegate(
        async () => {
          const params = new URLSearchParams();
          for (const id of agentActorIds) params.append("agentId", id);
          const out = await client.get<{ items: CloudAgentDefault[] }>(`/v1/runtime/agent-defaults?${params}`);
          return out.items.map((row): AgentDefaultRow => ({
            id: row.id,
            agent_types: row.agentTypes ?? null,
            default_agent_type: row.defaultAgentType ?? null,
          }));
        },
        () => delegate.listAgentDefaults(agentActorIds),
      );
    },
    async updateRuntimeModel(runtimeId, model) {
      await client.patch<void>(`/v1/runtime/${encodeURIComponent(runtimeId)}/model`, { model });
    },
    async listSessionRuntimeModels(sessionId) {
      return cloudOrDelegate(
        async () => {
          const out = await client.get<{ items: SessionRuntimeModelRow[] }>(
            `/v1/sessions/${encodeURIComponent(sessionId)}/runtime-models`,
          );
          return out.items;
        },
        () => delegate.listSessionRuntimeModels(sessionId),
      );
    },
    async listRuntimeTargetsForSession(sessionId, agentActorIds) {
      return cloudOrDelegate(
        async () => {
          const params = new URLSearchParams();
          for (const id of agentActorIds) params.append("agentId", id);
          const out = await client.get<{ items: RuntimeTargetRow[] }>(
            `/v1/sessions/${encodeURIComponent(sessionId)}/runtime-targets?${params}`,
          );
          return out.items;
        },
        () => delegate.listRuntimeTargetsForSession(sessionId, agentActorIds),
      );
    },
    async listDaemonRuntimes(teamId) {
      const out = await client.get<{ items: CloudAgentRuntime[] }>(`/v1/runtime?teamId=${encodeURIComponent(teamId)}`);
      return out.items.map(mapRuntime);
    },
  };
}
