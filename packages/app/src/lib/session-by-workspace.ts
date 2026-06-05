import { loadSessionWorkspacesForTeam, type SessionWorkspaceRow } from "@/lib/local-cache";
import { workspacePathsMatch } from "@/stores/session-utils";

export function workspaceLabelFromPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.split("/").pop() || trimmed;
}

function labelFromSessionWorkspaceRow(row: SessionWorkspaceRow): string | null {
  return workspaceLabelFromPath(row.workspacePath) ?? row.workspaceId ?? null;
}

function pickBestSessionWorkspaceRow(
  rows: SessionWorkspaceRow[],
  sessionId: string,
): SessionWorkspaceRow | null {
  let best: SessionWorkspaceRow | null = null;
  for (const row of rows) {
    if (row.sessionId !== sessionId) continue;
    if (!best || row.updatedAt > best.updatedAt) best = row;
  }
  return best;
}

/** Newest session_workspace row for a session → local filesystem path, if known. */
export async function resolveSessionWorkspacePath(
  teamId: string,
  sessionId: string,
): Promise<string | null> {
  const rows = await loadSessionWorkspacesForTeam(teamId);
  const best = pickBestSessionWorkspaceRow(rows, sessionId);
  if (!best) return null;

  const path = best.workspacePath?.trim();
  if (path) return path;

  const workspaceId = best.workspaceId?.trim();
  if (!workspaceId) return null;

  const { listDaemonWorkspaces } = await import("@/lib/daemon-workspaces");
  const workspaces = await listDaemonWorkspaces(teamId).catch(() => []);
  const match = workspaces.find((w) => !w.archived && w.id === workspaceId);
  return match?.path?.trim() ?? null;
}

/** Switch the desktop workspace when opening a session bound to another folder. */
export async function switchToSessionWorkspaceIfNeeded(
  teamId: string,
  sessionId: string,
): Promise<void> {
  const targetPath = await resolveSessionWorkspacePath(teamId, sessionId);
  if (!targetPath) return;

  const { useWorkspaceStore } = await import("@/stores/workspace");
  const currentPath = useWorkspaceStore.getState().workspacePath;
  if (currentPath && workspacePathsMatch(currentPath, targetPath)) return;

  await useWorkspaceStore.getState().setWorkspace(targetPath);
}

/** sessionId → short workspace label (folder basename), newest row wins per session. */
export async function loadSessionWorkspaceLabelsForTeam(
  teamId: string,
): Promise<Map<string, string>> {
  const rows = await loadSessionWorkspacesForTeam(teamId);
  const bestBySession = new Map<string, { label: string; updatedAt: string }>();
  for (const row of rows) {
    const label = labelFromSessionWorkspaceRow(row);
    if (!label) continue;
    const prev = bestBySession.get(row.sessionId);
    if (!prev || row.updatedAt > prev.updatedAt) {
      bestBySession.set(row.sessionId, { label, updatedAt: row.updatedAt });
    }
  }
  return new Map([...bestBySession.entries()].map(([sessionId, { label }]) => [sessionId, label]));
}

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
