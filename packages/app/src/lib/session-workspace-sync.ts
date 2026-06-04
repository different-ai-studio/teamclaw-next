import { listDaemonRuntimes } from "@/lib/daemon-runtimes";
import { upsertSessionWorkspacesBatch, type SessionWorkspaceRow } from "@/lib/local-cache";

/**
 * Pull session → workspace links from the cloud daemon-runtimes list and
 * persist them into the local libsql `session_workspace` table. The session
 * list workspace filter reads ONLY this local table, so it keeps working
 * offline after the first sync. A runtime contributes a row only once the
 * daemon has stamped its workspace_id (see daemon cloud_api upsert fix).
 */
export async function syncSessionWorkspaces(teamId: string): Promise<void> {
  const runtimes = await listDaemonRuntimes(teamId);
  const now = new Date().toISOString();
  const rows: SessionWorkspaceRow[] = [];
  for (const rt of runtimes) {
    if (!rt.sessionId) continue;
    if (!rt.workspaceId && !rt.workspacePath) continue;
    rows.push({
      sessionId: rt.sessionId,
      teamId,
      workspaceId: rt.workspaceId ?? null,
      workspacePath: rt.workspacePath ?? null,
      updatedAt: now,
    });
  }
  if (rows.length === 0) return;
  await upsertSessionWorkspacesBatch(rows);
}
