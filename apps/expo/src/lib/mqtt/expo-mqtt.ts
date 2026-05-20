import mqttPkg from "mqtt";
import * as mqttNamespace from "mqtt";
import type { IClientOptions, MqttClient } from "mqtt";

// Metro's React-Native condition resolves the `mqtt` package to its prebuilt
// ESM bundle (`dist/mqtt.esm.js`), which only ships `export default`. Node
// resolution exposes a namespace with `connect` directly. Pick whichever
// shape actually has `connect` so vitest, Metro, and Node tests all work.
type MqttNamespace = {
  connect: (url: string, options?: IClientOptions) => unknown;
};
const mqtt: MqttNamespace = (mqttPkg && typeof (mqttPkg as MqttNamespace).connect === "function"
  ? (mqttPkg as MqttNamespace)
  : (mqttNamespace as unknown as MqttNamespace));

export type ExpoMqttMessage = {
  topic: string;
  payload: Uint8Array;
};

export type ExpoMqttConnectOptions = Pick<
  IClientOptions,
  | "clientId"
  | "username"
  | "password"
  | "clean"
  | "keepalive"
  | "reconnectPeriod"
  | "connectTimeout"
  | "protocol"
  | "hostname"
  | "port"
  | "path"
  | "rejectUnauthorized"
>;

export type ExpoMqttConnectArgs = {
  url: string;
  options?: ExpoMqttConnectOptions;
};

type ExpoMqttClientEventMap = {
  close: () => void;
  connect: () => void;
  error: (error: Error) => void;
  message: (topic: string, payload: Uint8Array) => void;
  offline: () => void;
};

type ExpoMqttClient = {
  on<E extends keyof ExpoMqttClientEventMap>(
    event: E,
    handler: ExpoMqttClientEventMap[E],
  ): ExpoMqttClient;
  once<E extends keyof ExpoMqttClientEventMap>(
    event: E,
    handler: ExpoMqttClientEventMap[E],
  ): ExpoMqttClient;
  removeListener<E extends keyof ExpoMqttClientEventMap>(
    event: E,
    handler: ExpoMqttClientEventMap[E],
  ): ExpoMqttClient;
  subscribe: (topic: string, callback: (error?: Error | null) => void) => void;
  publish: (
    topic: string,
    payload: Uint8Array | string,
    options: { retain?: boolean },
    callback: (error?: Error | null) => void,
  ) => void;
  end: (force: boolean, options: Record<string, never>, callback: () => void) => void;
};

export type ExpoMqttAdapter = {
  connect: (args: ExpoMqttConnectArgs) => Promise<void>;
  subscribe: (topic: string) => Promise<void>;
  publish: (topic: string, payload: Uint8Array, retain?: boolean) => Promise<void>;
  disconnect: () => Promise<void>;
  onMessage: (handler: (message: ExpoMqttMessage) => void) => () => void;
  onConnectionState: (
    handler: (state: "connecting" | "connected" | "disconnected") => void,
  ) => () => void;
};

export type ExpoMqttAdapterDeps = {
  createClient?: (url: string, options?: ExpoMqttConnectOptions) => ExpoMqttClient;
};

function toMqttOptions(options?: ExpoMqttConnectOptions): ExpoMqttConnectOptions | undefined {
  return options;
}

function defaultCreateClient(url: string, options?: ExpoMqttConnectOptions): ExpoMqttClient {
  return mqtt.connect(url, toMqttOptions(options)) as unknown as ExpoMqttClient;
}

export function createExpoMqttAdapter(deps: ExpoMqttAdapterDeps = {}): ExpoMqttAdapter {
  const createClient = deps.createClient ?? defaultCreateClient;
  let client: ExpoMqttClient | null = null;
  const messageHandlers = new Set<(message: ExpoMqttMessage) => void>();
  const connectionStateHandlers = new Set<
    (state: "connecting" | "connected" | "disconnected") => void
  >();
  let pendingConnectCleanup: (() => void) | null = null;
  let pendingConnectReject: ((reason?: unknown) => void) | null = null;

  function relayMessage(topic: string, payload: Uint8Array) {
    const message = { topic, payload: new Uint8Array(payload) };
    for (const handler of messageHandlers) {
      handler(message);
    }
  }

  function relayConnectionState(state: "connecting" | "connected" | "disconnected") {
    for (const handler of connectionStateHandlers) {
      handler(state);
    }
  }

  return {
    async connect(args) {
      if (client) {
        throw new Error("MQTT client is already connected");
      }

      const nextClient = createClient(args.url, args.options);
      client = nextClient;
      relayConnectionState("connecting");

      return new Promise<void>((resolve, reject) => {
        pendingConnectReject = reject;

        const handleConnect = () => {
          nextClient.removeListener("connect", handleConnect);
          nextClient.removeListener("error", handleError);
          pendingConnectCleanup = null;
          nextClient.on("message", relayMessage);
          nextClient.on("close", handleDisconnected);
          nextClient.on("offline", handleDisconnected);
          nextClient.on("error", handleDisconnectedError);
          pendingConnectReject = null;
          relayConnectionState("connected");
          resolve();
        };

        const handleError = (error: Error) => {
          nextClient.removeListener("connect", handleConnect);
          nextClient.removeListener("error", handleError);
          pendingConnectCleanup = null;
          pendingConnectReject = null;
          if (client === nextClient) {
            client = null;
          }
          relayConnectionState("disconnected");
          reject(error);
        };

        const handleDisconnected = () => {
          if (client === nextClient) {
            client = null;
          }
          relayConnectionState("disconnected");
        };

        const handleDisconnectedError = (_error: Error) => {
          handleDisconnected();
        };

        pendingConnectCleanup = () => {
          nextClient.removeListener("connect", handleConnect);
          nextClient.removeListener("error", handleError);
        };

        nextClient.once("connect", handleConnect);
        nextClient.once("error", handleError);
      });
    },
    async subscribe(topic) {
      const currentClient = client;
      if (!currentClient) {
        throw new Error("MQTT client is not connected");
      }

      await new Promise<void>((resolve, reject) => {
        currentClient.subscribe(topic, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    async publish(topic, payload, retain = false) {
      const currentClient = client;
      if (!currentClient) {
        throw new Error("MQTT client is not connected");
      }

      await new Promise<void>((resolve, reject) => {
        currentClient.publish(topic, payload, { retain }, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    async disconnect() {
      if (!client) {
        pendingConnectCleanup?.();
        pendingConnectCleanup = null;
        if (pendingConnectReject) {
          pendingConnectReject(new Error("MQTT connection was closed before becoming ready"));
          pendingConnectReject = null;
        }
        relayConnectionState("disconnected");
        return;
      }

      const currentClient = client;
      client = null;
      pendingConnectCleanup?.();
      pendingConnectCleanup = null;
      if (pendingConnectReject) {
        pendingConnectReject(new Error("MQTT connection was closed before becoming ready"));
        pendingConnectReject = null;
      }
      relayConnectionState("disconnected");

      await new Promise<void>((resolve) => {
        currentClient.end(false, {}, resolve);
      });
    },
    onMessage(handler) {
      messageHandlers.add(handler);

      return () => {
        messageHandlers.delete(handler);
      };
    },
    onConnectionState(handler) {
      connectionStateHandlers.add(handler);

      return () => {
        connectionStateHandlers.delete(handler);
      };
    },
  };
}
