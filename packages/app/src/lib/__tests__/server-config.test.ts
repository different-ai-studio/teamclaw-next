import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("server config", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves cloudApiUrl from the build config / env, never from a saved override", async () => {
    vi.stubEnv("VITE_CLOUD_API_URL", "https://build.example.com");

    const { getEffectiveServerConfig, getEffectiveServerConfigSync, saveServerConfig } = await import(
      "../server-config"
    );

    // A persisted cloudApiUrl must be ignored — the build config is the single
    // source of truth, so a stale value can never shadow it.
    await saveServerConfig({ cloudApiUrl: "https://stale.example.com" });

    expect(getEffectiveServerConfigSync().cloudApiUrl).toBe("https://build.example.com");
    expect((await getEffectiveServerConfig()).cloudApiUrl).toBe("https://build.example.com");
  });

  it("persists MQTT broker config delivered by bootstrap", async () => {
    const { getEffectiveServerConfigSync, saveServerConfig } = await import("../server-config");

    await saveServerConfig({
      mqttHost: " mqtt.example.com ",
      mqttPort: 1883,
      mqttUseTls: false,
    });

    const config = getEffectiveServerConfigSync();
    expect(config.mqttHost).toBe("mqtt.example.com");
    expect(config.mqttPort).toBe(1883);
    expect(config.mqttUseTls).toBe(false);
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
