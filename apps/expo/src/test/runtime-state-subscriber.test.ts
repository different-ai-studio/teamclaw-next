import { describe, expect, it, vi } from "vitest";

import type { TeamMqttClient } from "../lib/mqtt/team-mqtt";
import { createRuntimeStateSubscriber } from "../features/actors/runtime-state-subscriber";

function fakeMqtt(): TeamMqttClient & { fire: (topic: string, payload: Uint8Array) => void } {
  const handlers = new Map<string, (p: Uint8Array, t: string) => void>();
  return {
    async start() {},
    subscribe(filter, handler) {
      handlers.set(filter, handler);
      return () => { handlers.delete(filter); };
    },
    async publish() {},
    onConnectionState() { return () => {}; },
    async dispose() { handlers.clear(); },
    fire(topic, payload) {
      for (const [filter, handler] of handlers) {
        // crude: only matches if filter contains "+/state" and ends correctly
        if (topic.includes("/runtime/") && topic.endsWith("/state")) handler(payload, topic);
      }
    },
  };
}

describe("RuntimeStateSubscriber", () => {
  it("watchDevice subscribes to the device-scoped wildcard", () => {
    const mqtt = fakeMqtt();
    const subscribeSpy = vi.spyOn(mqtt, "subscribe");
    const sub = createRuntimeStateSubscriber({
      mqtt, teamId: "team1",
      decode: () => ({ runtimeId: "r1", status: 1, currentModel: "", availableModels: [], agentType: 1 }),
      onRuntimeInfo: () => {},
    });
    sub.watchDevice("dev1");
    expect(subscribeSpy).toHaveBeenCalledWith(
      "amux/team1/device/dev1/runtime/+/state",
      expect.any(Function),
    );
  });

  it("invokes onRuntimeInfo with (deviceId, runtimeId, info) extracted from the topic", () => {
    const mqtt = fakeMqtt();
    const cb = vi.fn();
    const decodedInfo = { runtimeId: "rt-from-decode", status: 5, currentModel: "m", availableModels: [], agentType: 1 };
    const sub = createRuntimeStateSubscriber({
      mqtt, teamId: "team1",
      decode: () => decodedInfo,
      onRuntimeInfo: cb,
    });
    sub.watchDevice("dev1");
    mqtt.fire("amux/team1/device/dev1/runtime/r-topic/state", new Uint8Array([1, 2]));
    expect(cb).toHaveBeenCalledWith("dev1", "r-topic", decodedInfo);
  });
});
