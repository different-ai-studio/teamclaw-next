import { loadSessionWorkspacesForTeam } from "@/lib/local-cache";
import { workspacePathsMatch } from "@/stores/session-utils";

/**
 * Resolve the set of session ids that belong to a workspace, reading ONLY the
 * local libsql `session_workspace` table (offline, no cloud round-trip).
 * Primary key is the exact cloud workspace_id; `workspacePathsMatch` on the
 * stored path is the fallback for rows whose workspace_id wasn't captured.
 */
export async function loadSessionIdsForWorkspace(
  teamId: string,
  target: { workspaceId: string | null; path: string },
): Promise<Set<string>> {
  const rows = await loadSessionWorkspacesForTeam(teamId);
  const ids = new Set<string>();
  for (const r of rows) {
    const byId = !!target.workspaceId && r.workspaceId === target.workspaceId;
    const byPath = !!r.workspacePath && !!target.path && workspacePathsMatch(r.workspacePath, target.path);
    if (byId || byPath) ids.add(r.sessionId);
  }
  return ids;
}
