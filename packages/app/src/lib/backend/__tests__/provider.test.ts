import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasSupabaseConfig: true,
  supabase: { marker: "supabase-client" },
}));

vi.mock("@/lib/supabase-client", () => ({
  get hasSupabaseConfig() {
    return mocks.hasSupabaseConfig;
  },
  SUPABASE_CONFIG_MISSING_MESSAGE:
    "Supabase config missing. Configure a server before signing in.",
  supabase: mocks.supabase,
}));

describe("backend provider facade", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.hasSupabaseConfig = true;
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
    mocks.hasSupabaseConfig = false;
    expect(hasBackendConfig()).toBe(false);
    expect(BACKEND_CONFIG_MISSING_MESSAGE).toMatch(/Supabase config missing/);
  });
});
