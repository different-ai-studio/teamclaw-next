import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasSupabaseBackendConfig: true,
}));

vi.mock("../supabase/config", () => ({
  BACKEND_CONFIG_MISSING_MESSAGE: "Supabase config missing. Configure a server before signing in.",
  hasSupabaseBackendConfig: () => mocks.hasSupabaseBackendConfig,
}));

vi.mock("../supabase", () => ({
  createSupabaseBackend: () => ({
    kind: "supabase",
    auth: {},
    directory: {},
    sessions: {
      listCurrentActorSessions: () => Promise.reject(new Error("sessions backend not implemented")),
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
    mocks.hasSupabaseBackendConfig = true;
  });

  it("defaults to a Supabase backend singleton", async () => {
    const { getBackend } = await import("../provider");

    const first = getBackend();
    const second = getBackend();

    expect(first).toBe(second);
    expect(first.kind).toBe("supabase");
    expect(first.auth).toBeDefined();
    expect(first.directory).toBeDefined();
    expect(first.sessions).toBeDefined();
    expect(first.messages).toBeDefined();
    expect(first.runtime).toBeDefined();
    expect(first.attachments).toBeDefined();
    expect(first.teams).toBeDefined();
    expect(first.ideas).toBeDefined();
    expect(first.actors).toBeDefined();
    expect(first.sessionMembers).toBeDefined();
    expect(first.shortcuts).toBeDefined();
    expect(first.notifications).toBeDefined();
    expect(first.teamWorkspaceConfig).toBeDefined();
    expect(first.workspaces).toBeDefined();
    expect(first.sync).toBeDefined();
    expect(first.telemetry).toBeDefined();
  });

  it("keeps placeholder backend methods promise-rejecting", async () => {
    const { getBackend } = await import("../provider");

    const first = getBackend();

    await expect(first.sessions.listCurrentActorSessions({ limit: 1, cursor: null })).rejects.toThrow(
      /sessions backend not implemented/,
    );
  });

  it("reports backend config status using existing Supabase config", async () => {
    const { hasBackendConfig, BACKEND_CONFIG_MISSING_MESSAGE } = await import("../provider");

    expect(hasBackendConfig()).toBe(true);
    mocks.hasSupabaseBackendConfig = false;
    expect(hasBackendConfig()).toBe(false);
    expect(BACKEND_CONFIG_MISSING_MESSAGE).toMatch(/Supabase config missing/);
  });

  it("selects PocketBase when saved server config requests it", async () => {
    localStorage.setItem(
      "teamclaw.serverConfig",
      JSON.stringify({
        backendKind: "pocketbase",
        pocketbaseUrl: "http://127.0.0.1:8090",
      }),
    );

    const { getBackend, hasBackendConfig } = await import("../provider");

    const backend = getBackend();

    expect(hasBackendConfig()).toBe(true);
    expect(backend.kind).toBe("pocketbase");
    await expect(backend.telemetry.listLeaderboard("team-1")).rejects.toMatchObject({
      category: "Unsupported",
      operation: "pocketbase.telemetry.listLeaderboard",
    });
  });
});
