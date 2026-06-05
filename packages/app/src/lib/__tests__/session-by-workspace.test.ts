import { describe, it, expect, vi, beforeEach } from "vitest";

const { loadSessionWorkspacesForTeam } = vi.hoisted(() => ({
  loadSessionWorkspacesForTeam: vi.fn(),
}));
const { listDaemonWorkspaces } = vi.hoisted(() => ({
  listDaemonWorkspaces: vi.fn(),
}));
vi.mock("@/lib/local-cache", () => ({ loadSessionWorkspacesForTeam }));
vi.mock("@/lib/daemon-workspaces", () => ({ listDaemonWorkspaces }));

const workspaceStoreState = vi.hoisted(() => ({
  workspacePath: null as string | null,
  setWorkspace: vi.fn(async (path: string) => {
    workspaceStoreState.workspacePath = path;
  }),
}));
vi.mock("@/stores/workspace", () => ({
  useWorkspaceStore: {
    getState: () => workspaceStoreState,
  },
}));

import { loadSessionIdsForWorkspace, loadSessionWorkspaceLabelsForTeam, resolveSessionWorkspacePath, switchToSessionWorkspaceIfNeeded } from "@/lib/session-by-workspace";

describe("loadSessionIdsForWorkspace", () => {
  beforeEach(() => loadSessionWorkspacesForTeam.mockReset());

  it("matches by workspaceId exactly", async () => {
    loadSessionWorkspacesForTeam.mockResolvedValue([
      { sessionId: "s1", workspaceId: "ws1", workspacePath: "/p/1" },
      { sessionId: "s2", workspaceId: "ws2", workspacePath: "/p/2" },
    ]);
    const ids = await loadSessionIdsForWorkspace("teamA", { workspaceId: "ws1", path: "/p/1" });
    expect([...ids]).toEqual(["s1"]);
  });

  it("falls back to path match when workspaceId is null", async () => {
    loadSessionWorkspacesForTeam.mockResolvedValue([
      { sessionId: "s1", workspaceId: null, workspacePath: "/Users/me/proj/" },
    ]);
    const ids = await loadSessionIdsForWorkspace("teamA", { workspaceId: null, path: "/Users/me/proj" });
    expect([...ids]).toEqual(["s1"]); // workspacePathsMatch ignores trailing slash
  });

  it("returns empty set when nothing matches", async () => {
    loadSessionWorkspacesForTeam.mockResolvedValue([
      { sessionId: "s1", workspaceId: "ws9", workspacePath: "/x" },
    ]);
    const ids = await loadSessionIdsForWorkspace("teamA", { workspaceId: "ws1", path: "/p/1" });
    expect(ids.size).toBe(0);
  });
});

describe("loadSessionWorkspaceLabelsForTeam", () => {
  beforeEach(() => loadSessionWorkspacesForTeam.mockReset());

  it("maps session id to folder basename, preferring newest row", async () => {
    loadSessionWorkspacesForTeam.mockResolvedValue([
      { sessionId: "s1", workspacePath: "/Users/me/copilot-ws-v2", updatedAt: "2026-01-01T00:00:00Z" },
      { sessionId: "s1", workspacePath: "/Users/me/copilot-ws-v3", updatedAt: "2026-06-01T00:00:00Z" },
      { sessionId: "s2", workspacePath: "/tmp/demo-ws/", updatedAt: "2026-01-01T00:00:00Z" },
    ]);
    const labels = await loadSessionWorkspaceLabelsForTeam("teamA");
    expect(labels.get("s1")).toBe("copilot-ws-v3");
    expect(labels.get("s2")).toBe("demo-ws");
  });
});

describe("resolveSessionWorkspacePath", () => {
  beforeEach(() => {
    loadSessionWorkspacesForTeam.mockReset();
    listDaemonWorkspaces.mockReset();
  });

  it("returns the newest workspace path for the session", async () => {
    loadSessionWorkspacesForTeam.mockResolvedValue([
      { sessionId: "s1", workspacePath: "/Users/me/old", updatedAt: "2026-01-01T00:00:00Z" },
      { sessionId: "s1", workspacePath: "/Users/me/new", updatedAt: "2026-06-01T00:00:00Z" },
    ]);
    await expect(resolveSessionWorkspacePath("teamA", "s1")).resolves.toBe("/Users/me/new");
  });

  it("falls back to daemon workspace path by workspace id", async () => {
    loadSessionWorkspacesForTeam.mockResolvedValue([
      { sessionId: "s1", workspaceId: "ws1", workspacePath: null, updatedAt: "2026-06-01T00:00:00Z" },
    ]);
    listDaemonWorkspaces.mockResolvedValue([
      { id: "ws1", path: "/Users/me/from-cloud", archived: false },
    ]);
    await expect(resolveSessionWorkspacePath("teamA", "s1")).resolves.toBe("/Users/me/from-cloud");
  });
});

describe("switchToSessionWorkspaceIfNeeded", () => {
  beforeEach(() => {
    loadSessionWorkspacesForTeam.mockReset();
    listDaemonWorkspaces.mockReset();
    workspaceStoreState.workspacePath = null;
    workspaceStoreState.setWorkspace.mockClear();
  });

  it("switches workspace when session path differs from current", async () => {
    workspaceStoreState.workspacePath = "/Users/me/copilot-ws-v2";
    loadSessionWorkspacesForTeam.mockResolvedValue([
      { sessionId: "s1", workspacePath: "/Users/me/copilot-ws-v3", updatedAt: "2026-06-01T00:00:00Z" },
    ]);
    await switchToSessionWorkspaceIfNeeded("teamA", "s1");
    expect(workspaceStoreState.setWorkspace).toHaveBeenCalledWith("/Users/me/copilot-ws-v3");
  });

  it("skips switch when session path matches current workspace", async () => {
    workspaceStoreState.workspacePath = "/Users/me/copilot-ws-v3";
    loadSessionWorkspacesForTeam.mockResolvedValue([
      { sessionId: "s1", workspacePath: "/Users/me/copilot-ws-v3/", updatedAt: "2026-06-01T00:00:00Z" },
    ]);
    await switchToSessionWorkspaceIfNeeded("teamA", "s1");
    expect(workspaceStoreState.setWorkspace).not.toHaveBeenCalled();
  });
});
