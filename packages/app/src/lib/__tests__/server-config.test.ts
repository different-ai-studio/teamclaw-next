import { beforeEach, describe, expect, it, vi } from "vitest";

describe("server config", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    delete window.__TEAMCLAW_SERVER_CONFIG__;
  });

  it("persists Cloud API provider fields in browser mode", async () => {
    const { getEffectiveServerConfig, saveServerConfig } = await import("../server-config");

    const saved = await saveServerConfig({
      backendKind: "cloud_api",
      cloudApiUrl: " https://fc.example.com ",
    });

    expect(saved).toMatchObject({
      backendKind: "cloud_api",
      cloudApiUrl: "https://fc.example.com",
    });
    expect(await getEffectiveServerConfig()).toMatchObject({
      backendKind: "cloud_api",
      cloudApiUrl: "https://fc.example.com",
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
