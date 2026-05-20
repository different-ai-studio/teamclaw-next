import type { ConnectedAgent } from "./connected-agent-types";

export type ConnectedAgentsCacheDb = {
  runAsync: (sql: string, ...params: unknown[]) => Promise<unknown>;
  getAllAsync: (sql: string, ...params: unknown[]) => Promise<Record<string, unknown>[]>;
};

export type ConnectedAgentsCache = {
  loadCache: (teamId: string) => Promise<ConnectedAgent[]>;
  saveCache: (teamId: string, agents: ConnectedAgent[]) => Promise<void>;
};

export function createConnectedAgentsCache(db: ConnectedAgentsCacheDb): ConnectedAgentsCache {
  return {
    async loadCache(teamId) {
      const rows = await db.getAllAsync(`SELECT * FROM connected_agents WHERE team_id = ?`, teamId);
      return rows.map((r) => ({
        agentId: String(r.agent_id),
        displayName: String(r.display_name),
        agentKind: String(r.agent_kind),
        permissionLevel: String(r.permission_level),
        visibility: r.visibility === "personal" ? "personal" : "team",
        isOwner: r.is_owner === 1 || r.is_owner === true,
        deviceId: r.device_id != null ? String(r.device_id) : null,
        lastActiveAt: r.last_active_at != null ? new Date(Number(r.last_active_at)).toISOString() : null,
      }));
    },
    async saveCache(teamId, agents) {
      await db.runAsync(`DELETE FROM connected_agents WHERE team_id = ?`, teamId);
      const now = Date.now();
      for (const a of agents) {
        await db.runAsync(
          `INSERT INTO connected_agents (
             team_id, agent_id, display_name, agent_kind, permission_level,
             visibility, is_owner, device_id, last_active_at, current_model, status, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          teamId, a.agentId, a.displayName, a.agentKind, a.permissionLevel,
          a.visibility, a.isOwner ? 1 : 0,
          a.deviceId,
          a.lastActiveAt ? Date.parse(a.lastActiveAt) : null,
          null, null, now,
        );
      }
    },
  };
}
