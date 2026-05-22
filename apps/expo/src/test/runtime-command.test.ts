import { fromBinary } from "@bufbuild/protobuf";
import { RuntimeCommandEnvelopeSchema } from "@teamclaw/app/proto/amux_pb";
import { describe, expect, it, vi } from "vitest";

import {
  createRuntimeCommandSender,
  resolvePermissionRuntimeTarget,
} from "../lib/teamclaw/runtime-command";

describe("runtime command sender", () => {
  it("publishes a grant_permission ACP command to the runtime command topic", async () => {
    const mqtt = { publish: vi.fn().mockResolvedValue(undefined) };
    const sender = createRuntimeCommandSender({
      mqtt,
      teamId: "team-1",
      peerId: "teamclaw-expo-member-1",
      senderActorId: "member-actor-1",
      commandId: () => "command-1",
      nowSeconds: () => 1_779_430_400,
    });

    await sender.sendPermissionResponse({
      targetDeviceId: "device-1",
      runtimeId: "rt-abcd",
      requestId: "perm-1",
      granted: true,
    });

    expect(mqtt.publish).toHaveBeenCalledTimes(1);
    const [topic, bytes, retain] = mqtt.publish.mock.calls[0] as [
      string,
      Uint8Array,
      boolean,
    ];
    expect(topic).toBe("amux/team-1/device/device-1/runtime/rt-abcd/commands");
    expect(retain).toBe(false);

    const envelope = fromBinary(RuntimeCommandEnvelopeSchema, bytes);
    expect(envelope.runtimeId).toBe("rt-abcd");
    expect(envelope.deviceId).toBe("device-1");
    expect(envelope.peerId).toBe("teamclaw-expo-member-1");
    expect(envelope.commandId).toBe("command-1");
    expect(envelope.timestamp).toBe(1_779_430_400n);
    expect(envelope.senderActorId).toBe("member-actor-1");
    expect(envelope.acpCommand?.command.case).toBe("grantPermission");
    if (envelope.acpCommand?.command.case !== "grantPermission") {
      throw new Error("expected grantPermission command");
    }
    expect(envelope.acpCommand.command.value.requestId).toBe("perm-1");
  });

  it("publishes a deny_permission ACP command and omits blank sender actor id", async () => {
    const mqtt = { publish: vi.fn().mockResolvedValue(undefined) };
    const sender = createRuntimeCommandSender({
      mqtt,
      teamId: "team-1",
      peerId: "peer-1",
      senderActorId: "",
      commandId: () => "command-2",
      nowSeconds: () => 1,
    });

    await sender.sendPermissionResponse({
      targetDeviceId: "device-1",
      runtimeId: "rt-abcd",
      requestId: "perm-2",
      granted: false,
    });

    const [, bytes] = mqtt.publish.mock.calls[0] as [string, Uint8Array, boolean];
    const envelope = fromBinary(RuntimeCommandEnvelopeSchema, bytes);
    expect(envelope.senderActorId).toBe("");
    expect(envelope.acpCommand?.command.case).toBe("denyPermission");
    if (envelope.acpCommand?.command.case !== "denyPermission") {
      throw new Error("expected denyPermission command");
    }
    expect(envelope.acpCommand.command.value.requestId).toBe("perm-2");
  });

  it("rejects before publishing when the runtime target is incomplete", async () => {
    const mqtt = { publish: vi.fn().mockResolvedValue(undefined) };
    const sender = createRuntimeCommandSender({
      mqtt,
      teamId: "team-1",
      peerId: "peer-1",
    });

    await expect(
      sender.sendPermissionResponse({
        targetDeviceId: "device-1",
        runtimeId: "",
        requestId: "perm-1",
        granted: true,
      }),
    ).rejects.toThrow("runtime id is required");
    expect(mqtt.publish).not.toHaveBeenCalled();
  });
});

describe("resolvePermissionRuntimeTarget", () => {
  it("chooses the requesting agent's live runtime and device when available", () => {
    const target = resolvePermissionRuntimeTarget({
      requestingActorId: "agent-2",
      agentParticipantIds: ["agent-1", "agent-2"],
      connectedAgents: [
        { agentId: "agent-1", deviceId: "device-1" },
        { agentId: "agent-2", deviceId: "device-2" },
      ],
      runtimeInfoByAgentId: new Map([
        ["agent-1", { runtimeId: "rt-1" }],
        ["agent-2", { runtimeId: "rt-2" }],
      ]),
      fallbackRuntime: null,
    });

    expect(target).toEqual({
      agentId: "agent-2",
      deviceId: "device-2",
      runtimeId: "rt-2",
    });
  });

  it("uses the Supabase runtime row when there is one agent participant and live state has not arrived", () => {
    const target = resolvePermissionRuntimeTarget({
      requestingActorId: "agent-1",
      agentParticipantIds: ["agent-1"],
      connectedAgents: [{ agentId: "agent-1", deviceId: "device-1" }],
      runtimeInfoByAgentId: new Map(),
      fallbackRuntime: { agentId: "agent-1", runtimeId: "rt-db" },
    });

    expect(target).toEqual({
      agentId: "agent-1",
      deviceId: "device-1",
      runtimeId: "rt-db",
    });
  });

  it("returns null when the agent device or runtime cannot be resolved", () => {
    expect(
      resolvePermissionRuntimeTarget({
        requestingActorId: "agent-1",
        agentParticipantIds: ["agent-1"],
        connectedAgents: [{ agentId: "agent-1", deviceId: null }],
        runtimeInfoByAgentId: new Map([["agent-1", { runtimeId: "rt-1" }]]),
        fallbackRuntime: null,
      }),
    ).toBeNull();
  });
});
