import { beforeEach, describe, expect, it, vi } from "vitest";

describe("server config", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    delete window.__TEAMCLAW_SERVER_CONFIG__;
  });

  it("persists PocketBase provider fields in browser mode", async () => {
    const { getEffectiveServerConfig, getSavedServerConfig, saveServerConfig } = await import("../server-config");

    const saved = await saveServerConfig({
      backendKind: "pocketbase",
      pocketbaseUrl: " http://127.0.0.1:8090 ",
      supabaseUrl: " ",
      supabaseAnonKey: "",
      mqttHost: " mqtt.local ",
      mqttPort: 1883,
      mqttUseTls: false,
      mqttUsername: " preview-mqtt ",
      mqttPassword: " preview-secret ",
    });

    expect(saved).toMatchObject({
      backendKind: "pocketbase",
      pocketbaseUrl: "http://127.0.0.1:8090",
      mqttHost: "mqtt.local",
      mqttPort: 1883,
      mqttUseTls: false,
      mqttUsername: "preview-mqtt",
      mqttPassword: "preview-secret",
    });
    expect(saved.supabaseUrl).toBeUndefined();
    expect(saved.supabaseAnonKey).toBeUndefined();

    expect(await getSavedServerConfig()).toMatchObject({
      backendKind: "pocketbase",
      pocketbaseUrl: "http://127.0.0.1:8090",
    });
    expect(await getEffectiveServerConfig()).toMatchObject({
      backendKind: "pocketbase",
      pocketbaseUrl: "http://127.0.0.1:8090",
      mqttUsername: "preview-mqtt",
      mqttPassword: "preview-secret",
    });
  });

  it("does not fall back to env MQTT credentials when saved config explicitly clears them", async () => {
    vi.stubEnv("VITE_MQTT_USERNAME", "teamclaw");
    vi.stubEnv("VITE_MQTT_PASSWORD", "teamclaw2026");

    localStorage.setItem(
      "teamclaw.serverConfig",
      JSON.stringify({
        mqttHost: "ai.ucar.cc",
        mqttPort: 1883,
        mqttUseTls: false,
        mqttUsername: null,
        mqttPassword: null,
      }),
    );

    const { getEffectiveServerConfigSync } = await import("../server-config");
    const config = getEffectiveServerConfigSync();

    expect(config.mqttUsername).toBeUndefined();
    expect(config.mqttPassword).toBeUndefined();
  });
});
