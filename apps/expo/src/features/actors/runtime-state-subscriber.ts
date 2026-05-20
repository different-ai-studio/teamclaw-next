import { extractWildcards } from "../../lib/mqtt/topic-match";
import type { TeamMqttClient } from "../../lib/mqtt/team-mqtt";
import type { RuntimeInfo } from "./connected-agent-types";

export type RuntimeStateSubscriber = {
  watchDevice: (deviceId: string) => void;
  unwatchDevice: (deviceId: string) => void;
  watchedDevices: () => Set<string>;
  dispose: () => void;
};

type Deps = {
  mqtt: TeamMqttClient;
  teamId: string;
  decode: (payload: Uint8Array) => RuntimeInfo | null;
  onRuntimeInfo: (deviceId: string, runtimeId: string, info: RuntimeInfo) => void;
};

export function createRuntimeStateSubscriber(deps: Deps): RuntimeStateSubscriber {
  const unsubscribes = new Map<string, () => void>();

  function topicFor(deviceId: string) {
    return `amux/${deps.teamId}/device/${deviceId}/runtime/+/state`;
  }

  return {
    watchDevice(deviceId) {
      if (unsubscribes.has(deviceId)) return;
      const filter = topicFor(deviceId);
      const off = deps.mqtt.subscribe(filter, (payload, topic) => {
        const segments = extractWildcards(
          `amux/${deps.teamId}/device/+/runtime/+/state`,
          topic,
        );
        if (!segments) return;
        const [, runtimeId] = segments;
        const info = deps.decode(payload);
        if (!info) return;
        deps.onRuntimeInfo(deviceId, runtimeId, info);
      });
      unsubscribes.set(deviceId, off);
    },
    unwatchDevice(deviceId) {
      const off = unsubscribes.get(deviceId);
      if (off) { off(); unsubscribes.delete(deviceId); }
    },
    watchedDevices() {
      return new Set(unsubscribes.keys());
    },
    dispose() {
      for (const off of unsubscribes.values()) off();
      unsubscribes.clear();
    },
  };
}
