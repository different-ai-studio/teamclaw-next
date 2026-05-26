import { beforeEach, describe, expect, it } from "vitest";

describe("server config", () => {
  beforeEach(() => {
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
    });

    expect(saved).toMatchObject({
      backendKind: "pocketbase",
      pocketbaseUrl: "http://127.0.0.1:8090",
      mqttHost: "mqtt.local",
      mqttPort: 1883,
      mqttUseTls: false,
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
    });
  });
});
