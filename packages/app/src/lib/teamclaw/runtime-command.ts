import { create, toBinary } from "@bufbuild/protobuf";
import {
  AcpCommandSchema,
  AcpDenyPermissionSchema,
  AcpGrantPermissionSchema,
  RuntimeCommandEnvelopeSchema,
} from "@/lib/proto/amux_pb";

export type RuntimeCommandMqtt = {
  publish: (topic: string, bytes: Uint8Array, retain?: boolean) => Promise<void>;
};

type RuntimeCommandSenderDeps = {
  mqtt: RuntimeCommandMqtt;
  teamId: string;
  peerId: string;
  senderActorId?: string | null;
  commandId?: () => string;
  nowSeconds?: () => number;
};

export type RuntimePermissionResponseInput = {
  targetDeviceId: string;
  runtimeId: string;
  requestId: string;
  granted: boolean;
};

export type RuntimeCommandSender = {
  sendPermissionResponse: (input: RuntimePermissionResponseInput) => Promise<void>;
};

export type PermissionRuntimeTarget = {
  agentId: string;
  deviceId: string;
  runtimeId: string;
};

export type PermissionRuntimeFallback = {
  agentId?: string | null;
  runtimeId?: string | null;
} | null;

function required(value: string | null | undefined, label: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

export function runtimeCommandsTopic(teamId: string, deviceId: string, runtimeId: string): string {
  return `amux/${teamId}/device/${deviceId}/runtime/${runtimeId}/commands`;
}

export function createRuntimeCommandSender(
  deps: RuntimeCommandSenderDeps,
): RuntimeCommandSender {
  return {
    async sendPermissionResponse(input) {
      const teamId = required(deps.teamId, "team id");
      const targetDeviceId = required(input.targetDeviceId, "target device id");
      const runtimeId = required(input.runtimeId, "runtime id");
      const requestId = required(input.requestId, "request id");
      const peerId = required(deps.peerId, "peer id");
      const acpCommand = input.granted
        ? create(AcpCommandSchema, {
            command: {
              case: "grantPermission",
              value: create(AcpGrantPermissionSchema, { requestId }),
            },
          })
        : create(AcpCommandSchema, {
            command: {
              case: "denyPermission",
              value: create(AcpDenyPermissionSchema, { requestId }),
            },
          });
      const senderActorId = deps.senderActorId?.trim() ?? "";
      const envelope = create(RuntimeCommandEnvelopeSchema, {
        runtimeId,
        deviceId: targetDeviceId,
        peerId,
        commandId: deps.commandId?.() ?? crypto.randomUUID(),
        timestamp: BigInt(Math.floor(deps.nowSeconds?.() ?? Date.now() / 1000)),
        senderActorId,
        acpCommand,
      });

      await deps.mqtt.publish(
        runtimeCommandsTopic(teamId, targetDeviceId, runtimeId),
        toBinary(RuntimeCommandEnvelopeSchema, envelope),
        false,
      );
    },
  };
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function fallbackRuntimeForAgent(
  fallbackRuntime: PermissionRuntimeFallback,
  agentId: string,
  agentParticipantCount: number,
): string {
  const runtimeId = fallbackRuntime?.runtimeId?.trim() ?? "";
  if (!runtimeId) return "";
  const fallbackAgentId = fallbackRuntime?.agentId?.trim() ?? "";
  if (fallbackAgentId === agentId) return runtimeId;
  return agentParticipantCount === 1 ? runtimeId : "";
}

export function resolvePermissionRuntimeTarget(args: {
  requestingActorId?: string | null;
  agentParticipantIds: ReadonlyArray<string>;
  connectedAgents: ReadonlyArray<{ agentId: string; deviceId: string | null | undefined }>;
  runtimeInfoByAgentId: ReadonlyMap<string, { runtimeId: string }>;
  fallbackRuntime: PermissionRuntimeFallback;
}): PermissionRuntimeTarget | null {
  const agentParticipantIds = unique(
    args.agentParticipantIds.map((id) => id.trim()).filter(Boolean),
  );
  if (agentParticipantIds.length === 0) return null;

  const participantSet = new Set(agentParticipantIds);
  const fallbackAgentId = args.fallbackRuntime?.agentId?.trim() ?? "";
  const candidates = unique([
    args.requestingActorId?.trim() ?? "",
    fallbackAgentId,
    ...agentParticipantIds,
  ].filter((id) => id && participantSet.has(id)));

  const connectedByAgentId = new Map<string, { agentId: string; deviceId: string }>();
  for (const agent of args.connectedAgents) {
    const deviceId = agent.deviceId?.trim() ?? "";
    if (agent.agentId && deviceId) connectedByAgentId.set(agent.agentId, { agentId: agent.agentId, deviceId });
  }

  for (const agentId of candidates) {
    const deviceId = connectedByAgentId.get(agentId)?.deviceId?.trim() ?? "";
    if (!deviceId) continue;

    const runtimeId =
      args.runtimeInfoByAgentId.get(agentId)?.runtimeId?.trim() ||
      fallbackRuntimeForAgent(args.fallbackRuntime, agentId, agentParticipantIds.length);
    if (!runtimeId) continue;

    return { agentId, deviceId, runtimeId };
  }

  return null;
}
