import { describe, it, expect, vi, beforeEach } from "vitest";

const { loadSessionWorkspacesForTeam } = vi.hoisted(() => ({
  loadSessionWorkspacesForTeam: vi.fn(),
}));
vi.mock("@/lib/local-cache", () => ({ loadSessionWorkspacesForTeam }));

import { loadSessionIdsForWorkspace } from "@/lib/session-by-workspace";

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
