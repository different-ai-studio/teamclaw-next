import type { DaemonWorkspaceBackendRow, WorkspacesBackend } from "../types";
import type { CloudApiClient } from "./http";

type CloudWorkspace = {
  id: string;
  teamId: string;
  agentId?: string | null;
  createdByMemberId?: string | null;
  name: string;
  path?: string | null;
  archived: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

type Page<T> = { items: T[]; nextCursor: string | null };

function mapWorkspace(row: CloudWorkspace): DaemonWorkspaceBackendRow {
  return {
    id: row.id,
    team_id: row.teamId,
    agent_id: row.agentId ?? null,
    created_by_member_id: row.createdByMemberId ?? null,
    name: row.name,
    path: row.path ?? null,
    archived: row.archived,
    created_at: row.createdAt ?? new Date().toISOString(),
    updated_at: row.updatedAt ?? new Date().toISOString(),
  };
}

export function createWorkspacesModule(client: CloudApiClient): WorkspacesBackend {
  return {
    async listWorkspacesByIds(_teamId, workspaceIds) {
      if (workspaceIds.length === 0) return [];
      // FC endpoint not yet available — fetch individually.
      const results = await Promise.all(
        workspaceIds.map(async (id) => {
          try {
            const w = await client.get<CloudWorkspace>(`/v1/workspaces/${encodeURIComponent(id)}`);
            return { id: w.id, name: w.name ?? null, path: w.path ?? null };
          } catch {
            return null;
          }
        }),
      );
      return results.filter((r): r is { id: string; name: string; path: string | null } => r !== null);
    },
    async listDaemonWorkspaces(teamId, agentId) {
      const params = new URLSearchParams({ teamId, limit: "200" });
      if (agentId) params.set("agentId", agentId);
      const page = await client.get<Page<CloudWorkspace>>(`/v1/workspaces?${params}`);
      return page.items.map(mapWorkspace);
    },
    async createDaemonWorkspace(input) {
      const row = await client.post<CloudWorkspace>("/v1/workspaces", {
        teamId: input.teamId,
        agentId: input.agentId,
        createdByMemberId: input.createdByMemberId,
        name: input.name,
        path: input.path,
        archived: false,
      });
      return mapWorkspace(row);
    },
    async updateDaemonWorkspace(input) {
      const row = await client.patch<CloudWorkspace>(`/v1/workspaces/${encodeURIComponent(input.workspaceId)}`, {
        name: input.name,
        path: input.path,
        archived: input.archived,
      });
      return mapWorkspace(row);
    },
  };
}
