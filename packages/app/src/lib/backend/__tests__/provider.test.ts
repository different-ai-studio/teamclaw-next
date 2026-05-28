import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../cloud-api", () => ({
  hasCloudApiBackendConfig: (config: { cloudApiUrl?: string }) =>
    Boolean(config.cloudApiUrl),
  createCloudApiBackend: () => ({
    kind: "cloud_api",
    auth: {},
    directory: {},
    sessions: {
      listCurrentActorSessions: () => Promise.resolve({ rows: [] }),
    },
    messages: {},
    runtime: {},
    attachments: {},
    teams: {},
    ideas: {},
    actors: {},
    sessionMembers: {},
    shortcuts: {},
    notifications: {},
    teamWorkspaceConfig: {},
    workspaces: {},
    sync: {},
    telemetry: {},
  }),
}));

describe("backend provider facade", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    delete window.__TEAMCLAW_SERVER_CONFIG__;
  });

  it("returns a singleton Cloud API backend", async () => {
    localStorage.setItem(
      "teamclaw.serverConfig",
      JSON.stringify({ backendKind: "cloud_api", cloudApiUrl: "https://cloud.ucar.cc" }),
    );

    const { getBackend, getBackendKind } = await import("../provider");

    const first = getBackend();
    const second = getBackend();

    expect(first).toBe(second);
    expect(first.kind).toBe("cloud_api");
    expect(getBackendKind()).toBe("cloud_api");
  });

  it("hasBackendConfig is true only when cloudApiUrl is set", async () => {
    const { hasBackendConfig } = await import("../provider");
    expect(hasBackendConfig()).toBe(false);

    localStorage.setItem(
      "teamclaw.serverConfig",
      JSON.stringify({ cloudApiUrl: "https://fc.example.com" }),
    );
    vi.resetModules();
    const fresh = await import("../provider");
    expect(fresh.hasBackendConfig()).toBe(true);
  });
});
