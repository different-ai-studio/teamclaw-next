import { getBackend } from "@/lib/backend";
import { mqttPublish } from "@/lib/mqtt-bridge";
import { resolvePermissionCommandTarget } from "@/lib/runtime-state-resolve";
import { sessionFlowError, sessionFlowLog } from "@/lib/session-flow-log";
import { useCurrentTeamStore } from "@/stores/current-team";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { createRuntimeCommandSender } from "@/lib/teamclaw/runtime-command";

export type AcpPermissionDecision = "allow" | "deny" | "always";

function isAgentActorType(actorType: string | null | undefined): boolean {
  const t = (actorType ?? "").toLowerCase();
  return t === "agent" || t === "ai" || t === "assistant";
}

export function findV2PendingPermission(requestId: string): {
  sessionId: string;
  actorId: string;
} | null {
  const trimmed = requestId.trim();
  if (!trimmed) return null;
  for (const entry of Object.values(useV2StreamingStore.getState().byKey)) {
    const pending = entry.pendingPermission;
    if (pending?.requestId === trimmed) {
      return { sessionId: entry.sessionId, actorId: entry.actorId };
    }
  }
  return null;
}

export async function replyAcpPermission(args: {
  sessionId: string;
  agentActorId: string;
  requestId: string;
  decision: AcpPermissionDecision;
}): Promise<void> {
  const teamId = useCurrentTeamStore.getState().team?.id?.trim();
  if (!teamId) throw new Error("No active team");

  const senderActorId = useCurrentTeamStore.getState().currentMember?.id?.trim() ?? "";
  const granted = args.decision !== "deny";

  let agentParticipantIds: string[] = [args.agentActorId];
  try {
    const participants = await getBackend().sessionMembers.listParticipants(args.sessionId);
    agentParticipantIds = participants
      .filter((p) => isAgentActorType(p.actor_type))
      .map((p) => p.id)
      .filter(Boolean);
    if (!agentParticipantIds.includes(args.agentActorId)) {
      agentParticipantIds.push(args.agentActorId);
    }
  } catch (error) {
    console.warn("[reply-acp-permission] participant lookup failed", error);
  }

  let sessionRuntimeRows: Array<{ agent_id: string | null; runtime_id: string | null }> = [];
  try {
    sessionRuntimeRows = await getBackend().runtime.listRuntimeTargetsForSession(
      args.sessionId,
      agentParticipantIds,
    );
  } catch (error) {
    console.warn("[reply-acp-permission] runtime target lookup failed", error);
  }

  const byRuntimeId = useRuntimeStateStore.getState().byRuntimeId;
  const target = resolvePermissionCommandTarget({
    agentActorId: args.agentActorId,
    sessionRuntimeRows,
    byRuntimeId,
  });

  if (!target) {
    throw new Error("Could not resolve agent runtime for permission response");
  }

  sessionFlowLog("permission.reply.begin", {
    sessionId: args.sessionId,
    agentActorId: args.agentActorId,
    requestId: args.requestId,
    granted,
    targetActorId: target.actorId,
    runtimeId: target.runtimeId,
    sessionRuntimeId:
      sessionRuntimeRows.find((row) => row.agent_id?.trim() === args.agentActorId)?.runtime_id ??
      null,
  });

  const peerId = `teamclaw-desktop-${(senderActorId || "anon").slice(0, 8)}`;
  const sender = createRuntimeCommandSender({
    mqtt: { publish: mqttPublish },
    teamId,
    peerId,
    senderActorId,
  });

  try {
    await sender.sendPermissionResponse({
      targetActorId: target.actorId,
      runtimeId: target.runtimeId,
      requestId: args.requestId,
      granted,
    });
  } catch (error) {
    sessionFlowError("permission.reply.failed", error, {
      sessionId: args.sessionId,
      agentActorId: args.agentActorId,
      requestId: args.requestId,
      runtimeId: target.runtimeId,
    });
    throw error;
  }

  sessionFlowLog("permission.reply.ok", {
    sessionId: args.sessionId,
    requestId: args.requestId,
    runtimeId: target.runtimeId,
  });

  useV2StreamingStore.getState().clearPermissionRequest(args.sessionId, args.agentActorId);
}

export async function replyPermissionById(
  permissionId: string,
  decision: AcpPermissionDecision,
): Promise<void> {
  const located = findV2PendingPermission(permissionId);
  if (!located) {
    throw new Error(`Unknown permission request: ${permissionId}`);
  }
  await replyAcpPermission({
    sessionId: located.sessionId,
    agentActorId: located.actorId,
    requestId: permissionId,
    decision,
  });
}
