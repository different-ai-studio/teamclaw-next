import { beforeEach, describe, expect, it, vi } from "vitest";
import { fromBinary } from "@bufbuild/protobuf";
import { RuntimeCommandEnvelopeSchema } from "@/lib/proto/amux_pb";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";

const mqttPublish = vi.fn().mockResolvedValue(undefined);
const listRuntimeTargetsForSession = vi.fn().mockResolvedValue([
  { agent_id: "agent-a", runtime_id: "rt-abcd" },
]);

vi.mock("@/lib/mqtt-bridge", () => ({
  mqttPublish: (...args: unknown[]) => mqttPublish(...args),
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    sessionMembers: {
      listParticipants: vi.fn().mockResolvedValue([
        { id: "agent-a", actor_type: "agent" },
      ]),
    },
    runtime: {
      listRuntimeTargetsForSession: (...args: unknown[]) =>
        listRuntimeTargetsForSession(...args),
    },
  }),
}));

vi.mock("@/stores/current-team", () => ({
  useCurrentTeamStore: {
    getState: () => ({
      team: { id: "team-1" },
      currentMember: { id: "member-1" },
    }),
  },
}));

vi.mock("@/stores/runtime-state-store", () => ({
  useRuntimeStateStore: {
    getState: () => ({ byRuntimeId: {} }),
  },
}));

const discardPendingStreamReply = vi.fn();

vi.mock("@/lib/live-agent-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/live-agent-stream")>();
  return {
    ...actual,
    discardPendingStreamReply: (...args: [string, string]) =>
      discardPendingStreamReply(...args),
  };
});

import { interruptAgentActor } from "@/lib/teamclaw/interrupt-agent";

describe("interruptAgentActor", () => {
  beforeEach(() => {
    mqttPublish.mockClear();
    discardPendingStreamReply.mockClear();
    listRuntimeTargetsForSession.mockReset();
    listRuntimeTargetsForSession.mockResolvedValue([
      { agent_id: "agent-a", runtime_id: "rt-abcd" },
    ]);
    useV2StreamingStore.setState({ byKey: {}, archived: [] });
    useV2StreamingStore.getState().appendOutput("session-1", "agent-a", "Hello");
  });

  it("publishes AcpCancel to the resolved runtime command topic", async () => {
    await interruptAgentActor({
      sessionId: "session-1",
      agentActorId: "agent-a",
    });

    expect(mqttPublish).toHaveBeenCalledTimes(1);
    const [topic, bytes] = mqttPublish.mock.calls[0] as [string, Uint8Array];
    expect(topic).toBe("amux/team-1/agent-a/runtime/rt-abcd/commands");

    const envelope = fromBinary(RuntimeCommandEnvelopeSchema, bytes);
    expect(envelope.acpCommand?.command.case).toBe("cancel");

    expect(discardPendingStreamReply).not.toHaveBeenCalled();
    expect(useV2StreamingStore.getState().byKey["session-1::agent-a"]?.active).toBe(true);
  });

  it("cleans up locally when runtime target cannot be resolved", async () => {
    listRuntimeTargetsForSession.mockResolvedValueOnce([]);

    await expect(
      interruptAgentActor({
        sessionId: "session-1",
        agentActorId: "agent-a",
      }),
    ).rejects.toThrow(/Could not resolve agent runtime/);

    expect(mqttPublish).not.toHaveBeenCalled();
    expect(discardPendingStreamReply).toHaveBeenCalledWith("session-1", "agent-a");
    expect(useV2StreamingStore.getState().byKey["session-1::agent-a"]?.active).toBe(false);
  });
});
