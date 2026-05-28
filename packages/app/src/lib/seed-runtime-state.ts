import { create } from "@bufbuild/protobuf";
import {
  AgentStatus,
  AgentType,
  ModelInfoSchema,
  RuntimeInfoSchema,
  RuntimeLifecycle,
  type RuntimeInfo,
} from "@/lib/proto/amux_pb";
import { availableModelsFor, type AmuxAgentType } from "@/lib/amuxd-models";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";

function amuxTypeFromAgentType(agentType: number): AmuxAgentType | null {
  switch (agentType) {
    case AgentType.CLAUDE_CODE:
      return "claude-code";
    case AgentType.OPENCODE:
      return "opencode";
    case AgentType.CODEX:
      return "codex";
    default:
      return null;
  }
}

function staticModelInfos(agentType: number) {
  const amuxType = amuxTypeFromAgentType(agentType);
  if (!amuxType) return [];
  return availableModelsFor(amuxType).map((model) =>
    create(ModelInfoSchema, { id: model.id, displayName: model.displayName }),
  );
}

/**
 * After runtimeStart RPC succeeds, seed the local runtime-state store so the
 * model picker is not blocked on a (possibly missed) MQTT retain. Authoritative
 * retains still overwrite via {@link useRuntimeStateStore.upsert}.
 */
export function seedRuntimeStateAfterStart(args: {
  daemonDeviceId: string;
  runtimeId: string;
  agentType: number;
}): void {
  const daemonDeviceId = args.daemonDeviceId.trim();
  const runtimeId = args.runtimeId.trim();
  if (!daemonDeviceId || !runtimeId) return;

  const store = useRuntimeStateStore.getState();
  const existing = store.byRuntimeId[runtimeId] ?? store.byRuntimeId[daemonDeviceId];
  if (existing && existing.info.availableModels.length > 0) return;

  const availableModels = staticModelInfos(args.agentType);
  const info: RuntimeInfo = create(RuntimeInfoSchema, {
    runtimeId,
    agentType: args.agentType,
    state: RuntimeLifecycle.ACTIVE,
    status: AgentStatus.IDLE,
    availableModels,
  });

  store.upsert(runtimeId, daemonDeviceId, info);
  if (runtimeId !== daemonDeviceId) {
    store.upsert(daemonDeviceId, daemonDeviceId, info);
  }
}
