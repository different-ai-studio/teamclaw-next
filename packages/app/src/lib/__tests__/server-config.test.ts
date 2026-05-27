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

  it("persists Cloud API provider fields in browser mode", async () => {
    const { getEffectiveServerConfig, saveServerConfig } = await import("../server-config");

    const saved = await saveServerConfig({
      backendKind: "cloud_api",
      cloudApiUrl: " https://fc.example.com ",
      supabaseUrl: " https://project.supabase.co ",
      supabaseAnonKey: " anon ",
    });

    expect(saved).toMatchObject({
      backendKind: "cloud_api",
      cloudApiUrl: "https://fc.example.com",
      supabaseUrl: "https://project.supabase.co",
      supabaseAnonKey: "anon",
    });
    expect(await getEffectiveServerConfig()).toMatchObject({
      backendKind: "cloud_api",
      cloudApiUrl: "https://fc.example.com",
    });
  });
});
