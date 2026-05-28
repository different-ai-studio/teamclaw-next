import { getBackend } from "@/lib/backend";
import { mqttPublish } from "@/lib/mqtt-bridge";
import { useCurrentTeamStore } from "@/stores/current-team";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import {
  createRuntimeCommandSender,
  resolvePermissionRuntimeTarget,
} from "@/lib/teamclaw/runtime-command";

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

  const runtimeInfoByAgentId = new Map<string, { runtimeId: string }>();
  for (const [runtimeId, entry] of Object.entries(useRuntimeStateStore.getState().byRuntimeId)) {
    const agentId = entry.daemonDeviceId?.trim() ?? "";
    if (!agentId) continue;
    runtimeInfoByAgentId.set(agentId, {
      runtimeId: entry.info.runtimeId?.trim() || runtimeId,
    });
  }

  let fallbackRuntime: { agentId: string; runtimeId: string } | null = null;
  try {
    const rows = await getBackend().runtime.listRuntimeTargetsForSession(
      args.sessionId,
      [args.agentActorId],
    );
    const row = rows.find((r) => r.agent_id === args.agentActorId);
    if (row?.runtime_id?.trim()) {
      fallbackRuntime = {
        agentId: args.agentActorId,
        runtimeId: row.runtime_id.trim(),
      };
    }
  } catch (error) {
    console.warn("[reply-acp-permission] runtime target lookup failed", error);
  }

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

  const connectedAgents = agentParticipantIds.map((agentId) => ({
    agentId,
    deviceId: agentId,
  }));

  const target = resolvePermissionRuntimeTarget({
    requestingActorId: args.agentActorId,
    agentParticipantIds,
    connectedAgents,
    runtimeInfoByAgentId,
    fallbackRuntime,
  });

  if (!target) {
    throw new Error("Could not resolve agent runtime for permission response");
  }

  const peerId = `teamclaw-desktop-${(senderActorId || "anon").slice(0, 8)}`;
  const sender = createRuntimeCommandSender({
    mqtt: { publish: mqttPublish },
    teamId,
    peerId,
    senderActorId,
  });

  await sender.sendPermissionResponse({
    targetDeviceId: target.deviceId,
    runtimeId: target.runtimeId,
    requestId: args.requestId,
    granted,
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
