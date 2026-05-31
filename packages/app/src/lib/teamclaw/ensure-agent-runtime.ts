import { getBackend } from "@/lib/backend";
import { ensureSessionLiveSubscribed, ensureTeamSessionLiveSubscribed } from "@/lib/session-live-subscriptions";
import { startAgentRuntimesAsync, type RuntimeStartFailure } from "@/lib/session-create";
import { waitForTeamclawRpcReady } from "@/lib/teamclaw-rpc";
import { useDevicePresenceStore } from "@/stores/device-presence-store";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import { resolveRuntimeStateEntryForAgent } from "@/lib/runtime-state-resolve";
import { resolveSessionWorkspaceHintForRuntimeStart } from "@/lib/teamclaw/resolve-runtime-start-workspace";
import { sessionFlowError, sessionFlowLog } from "@/lib/session-flow-log";
import { useWorkspaceStore } from "@/stores/workspace";

const inFlight = new Map<string, Promise<void>>();

export type AgentDevicePresence = "online" | "offline" | "unknown";

/**
 * Resolve whether an agent's daemon is reachable.
 *
 * MQTT retained DeviceState can arrive slightly after subscribe — `undefined`
 * in device-presence-store means "not yet known", not offline (see
 * SessionActorSheet computeDotStateAndAnimation). Only explicit `online:
 * false` (LWT) counts as offline. For the local desktop agent, HTTP probe
 * is used as a bootstrap when MQTT retain hasn't landed yet.
 */
export async function resolveAgentDevicePresence(
  agentActorId: string,
  opts?: { timeoutMs?: number },
): Promise<AgentDevicePresence> {
  const timeoutMs = opts?.timeoutMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const entry = useDevicePresenceStore.getState().byDeviceId[agentActorId];
    if (entry?.online === true) return "online";
    if (entry?.online === false) return "offline";
    await new Promise((r) => setTimeout(r, 100));
  }

  const entry = useDevicePresenceStore.getState().byDeviceId[agentActorId];
  if (entry?.online === true) return "online";
  if (entry?.online === false) return "offline";

  const { isTauri } = await import("@/lib/utils");
  if (isTauri()) {
    const { getLocalDaemonDeviceId } = await import("@/lib/daemon-agent-admin");
    const { probeDaemonHttp } = await import("@/lib/daemon-local-client");
    const localId = await getLocalDaemonDeviceId();
    if (localId === agentActorId) {
      const probe = await probeDaemonHttp();
      return probe.ok ? "online" : "offline";
    }
  }

  return "unknown";
}

function logDebug(
  eventCase: string,
  payload: unknown,
  opts?: { sessionId?: string; topic?: string; actorId?: string },
): void {
  void import("@/stores/acp-debug-store").then(({ useAcpDebugStore }) => {
    useAcpDebugStore.getState().append({
      sessionId: opts?.sessionId ?? "",
      topic: opts?.topic ?? "(client)",
      actorId: opts?.actorId ?? "",
      eventCase,
      payload,
    });
  });
}

async function ensureAgentIsSessionParticipant(sessionId: string, agentActorId: string): Promise<void> {
  const participants = await getBackend().sessionMembers.listParticipants(sessionId);
  if (participants.some((p) => p.id === agentActorId)) return;
  await getBackend().sessionMembers.addParticipant(sessionId, agentActorId);
  sessionFlowLog("ensure_agent_runtime.participant_added", { sessionId, agentActorId });
  logDebug("client:participant_added", { sessionId, agentActorId }, { sessionId, actorId: agentActorId });
}

function notifyRuntimeStartFailures(failures: RuntimeStartFailure[]): void {
  if (failures.length === 0) return;
  void import("sonner").then(({ toast }) => {
    for (const failure of failures) {
      const shortId = failure.agentActorId.slice(0, 8);
      toast.error("Agent runtime 未启动", {
        id: `runtime-start-failed-${failure.agentActorId}`,
        description:
          failure.reason.trim() ||
          `Agent ${shortId} 的 daemon 未响应 runtimeStart（可能未在线或未加入团队）。`,
        duration: 8000,
      });
      logDebug(
        "client:runtime_start_failed",
        failure,
        { actorId: failure.agentActorId },
      );
    }
  });
}

export type EnsureAgentRuntimeArgs = {
  sessionId: string;
  teamId: string;
  agentActorIds: string[];
  modelId?: string;
  modelIdByAgent?: Record<string, string>;
  /** Cloud workspace UUID captured at send time — passed through to runtimeStart. */
  workspaceIdHint?: string;
  reason?: string;
};

/**
 * Idempotent: ensure session live subscription, session membership, and
 * daemon runtimeStart for each agent. Safe to call on @-mention and on send.
 */
export async function ensureAgentRuntimesForSession(args: EnsureAgentRuntimeArgs): Promise<void> {
  const agentActorIds = [...new Set(args.agentActorIds.map((id) => id.trim()).filter(Boolean))];
  if (!args.sessionId || !args.teamId || agentActorIds.length === 0) return;

  const key = `${args.sessionId}::${agentActorIds.slice().sort().join(",")}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const work = (async () => {
    logDebug(
      "client:ensure_runtime_begin",
      { reason: args.reason ?? "unknown", agentActorIds, teamId: args.teamId },
      { sessionId: args.sessionId, topic: `ensure/${args.sessionId}` },
    );

    try {
      await ensureTeamSessionLiveSubscribed(args.teamId);
      await ensureSessionLiveSubscribed(args.teamId, args.sessionId);
    } catch (error) {
      sessionFlowError("ensure_agent_runtime.live_subscribe_failed", error, args);
      logDebug("client:live_subscribe_failed", { error: String(error) }, { sessionId: args.sessionId });
    }

    const rpcReady = await waitForTeamclawRpcReady(20_000);
    if (!rpcReady) {
      logDebug("client:rpc_not_ready", { waitedMs: 20_000 }, { sessionId: args.sessionId });
      void import("sonner").then(({ toast }) => {
        toast.error("MQTT/RPC 未就绪", {
          description: "无法向 daemon 发送 runtimeStart。请检查 MQTT 连接与团队登录状态。",
        });
      });
      return;
    }

    await Promise.all(
      agentActorIds.map(async (agentActorId) => {
        try {
          await ensureAgentIsSessionParticipant(args.sessionId, agentActorId);
        } catch (error) {
          sessionFlowError("ensure_agent_runtime.add_participant_failed", error, {
            sessionId: args.sessionId,
            agentActorId,
          });
          logDebug("client:add_participant_failed", { agentActorId, error: String(error) }, {
            sessionId: args.sessionId,
            actorId: agentActorId,
          });
        }
      }),
    );

    const localWorkspacePath = useWorkspaceStore.getState().workspacePath?.trim() || null
    const workspaceIdHint =
      args.workspaceIdHint?.trim() ||
      (await resolveSessionWorkspaceHintForRuntimeStart({
        teamId: args.teamId,
        localWorkspacePath,
        sessionId: args.sessionId,
        agentActorIds,
      })) ||
      undefined

    logDebug(
      "client:runtime_start_batch",
      {
        agentActorIds,
        modelId: args.modelId ?? null,
        workspaceIdHint: workspaceIdHint ?? null,
        localWorkspacePath,
      },
      { sessionId: args.sessionId, topic: `rpc/runtimeStart/${args.sessionId}` },
    );
    sessionFlowLog("ensure_agent_runtime.workspace_resolved", {
      sessionId: args.sessionId,
      teamId: args.teamId,
      reason: args.reason ?? "unknown",
      workspaceIdHint: workspaceIdHint ?? null,
      localWorkspacePath,
    });

    const runtimeFailures = await startAgentRuntimesAsync({
      sessionId: args.sessionId,
      teamId: args.teamId,
      agentActorIds,
      modelId: args.modelId,
      modelIdByAgent: args.modelIdByAgent,
      workspaceIdHint,
    });
    notifyRuntimeStartFailures(runtimeFailures);

    const retainDeadline = Date.now() + 12_000;
    while (Date.now() < retainDeadline) {
      const byRuntimeId = useRuntimeStateStore.getState().byRuntimeId;
      const missing = agentActorIds.filter((id) => {
        const entry = resolveRuntimeStateEntryForAgent(id, byRuntimeId);
        return !entry || entry.info.availableModels.length === 0;
      });
      if (missing.length === 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    for (const agentActorId of agentActorIds) {
      const entry = resolveRuntimeStateEntryForAgent(
        agentActorId,
        useRuntimeStateStore.getState().byRuntimeId,
      );
      logDebug(
        entry ? "client:runtime_state_observed" : "client:runtime_state_missing",
        entry
          ? {
              agentActorId,
              runtimeId: entry.info.runtimeId,
              agentType: entry.info.agentType,
              availableModelIds: entry.info.availableModels.map((m) => m.id),
            }
          : { agentActorId, waitedMs: 6_000 },
        { sessionId: args.sessionId, actorId: agentActorId },
      );
    }

    logDebug(
      "client:runtime_start_batch_done",
      { agentActorIds },
      { sessionId: args.sessionId, topic: `rpc/runtimeStart/${args.sessionId}` },
    );
  })().catch((error) => {
    sessionFlowError("ensure_agent_runtime.failed", error, args);
    logDebug("client:ensure_runtime_failed", { error: String(error) }, { sessionId: args.sessionId });
    void import("sonner").then(({ toast }) => {
      toast.error("启动 Agent runtime 失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    });
    throw error;
  });

  inFlight.set(key, work);
  try {
    await work;
  } finally {
    inFlight.delete(key);
  }
}
