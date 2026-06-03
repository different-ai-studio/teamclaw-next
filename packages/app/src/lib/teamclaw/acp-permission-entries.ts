import type { PendingPermissionEntry } from "@/stores/session-types";
import type { StreamingPermissionRequest } from "@/stores/v2-streaming-store";
import { shouldAutoAllowSessionPermissions } from "@/lib/session-permission-mode";

function inferPermissionType(toolName: string): string {
  const n = toolName.toLowerCase();
  if (n.includes("bash") || n.includes("shell") || n.includes("terminal") || n === "execute") {
    return "bash";
  }
  if (n.includes("write")) return "write";
  if (n.includes("edit")) return "edit";
  if (n.includes("read")) return "read";
  if (n.includes("skill")) return "skill";
  return n || "execute";
}

export function buildPendingEntryFromAcpPermission(
  sessionId: string,
  agentActorId: string,
  req: StreamingPermissionRequest,
): PendingPermissionEntry {
  const permType = inferPermissionType(req.toolName);
  const command =
    req.params.command ??
    req.params.cmd ??
    req.description ??
    req.toolName;

  return {
    permission: {
      id: req.requestId,
      sessionID: sessionId,
      permission: permType,
      patterns: command ? [command] : [],
      metadata: {
        ...req.params,
        _acp_agent_actor_id: agentActorId,
      },
      always: [],
    },
    childSessionId: null,
    sourceToolName: req.toolName || null,
    sourceToolCallId: null,
  };
}

export function collectAcpStreamingPermissions(
  activeSessionId: string | null,
  byKey: Record<
    string,
    { sessionId: string; actorId: string; pendingPermission: StreamingPermissionRequest | null }
  >,
): PendingPermissionEntry[] {
  if (!activeSessionId) return [];
  if (shouldAutoAllowSessionPermissions(activeSessionId)) return [];
  const out: PendingPermissionEntry[] = [];
  for (const entry of Object.values(byKey)) {
    if (entry.sessionId !== activeSessionId) continue;
    const pending = entry.pendingPermission;
    if (!pending?.requestId) continue;
    out.push(buildPendingEntryFromAcpPermission(entry.sessionId, entry.actorId, pending));
  }
  return out;
}
