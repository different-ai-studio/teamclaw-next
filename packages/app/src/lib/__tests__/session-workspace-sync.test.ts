import { describe, it, expect, vi, beforeEach } from "vitest";

const { listDaemonRuntimes, upsertSessionWorkspacesBatch } = vi.hoisted(() => ({
  listDaemonRuntimes: vi.fn(),
  upsertSessionWorkspacesBatch: vi.fn(),
}));

vi.mock("@/lib/daemon-runtimes", () => ({ listDaemonRuntimes }));
vi.mock("@/lib/local-cache", () => ({ upsertSessionWorkspacesBatch }));

import { syncSessionWorkspaces } from "@/lib/session-workspace-sync";

describe("syncSessionWorkspaces", () => {
  beforeEach(() => {
    listDaemonRuntimes.mockReset();
    upsertSessionWorkspacesBatch.mockReset();
  });

  it("upserts only runtimes that carry a session_id + workspace link", async () => {
    listDaemonRuntimes.mockResolvedValue([
      { sessionId: "s1", workspaceId: "ws1", workspacePath: "/p/1" },
      { sessionId: "s2", workspaceId: null, workspacePath: null }, // skip: no workspace
      { sessionId: null, workspaceId: "ws3", workspacePath: "/p/3" }, // skip: no session
    ]);
    await syncSessionWorkspaces("teamA");
    expect(upsertSessionWorkspacesBatch).toHaveBeenCalledTimes(1);
    const rows = upsertSessionWorkspacesBatch.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "s1",
      teamId: "teamA",
      workspaceId: "ws1",
      workspacePath: "/p/1",
    });
    expect(typeof rows[0].updatedAt).toBe("string");
  });

  it("no-ops when nothing to persist", async () => {
    listDaemonRuntimes.mockResolvedValue([{ sessionId: "s2", workspaceId: null, workspacePath: null }]);
    await syncSessionWorkspaces("teamA");
    expect(upsertSessionWorkspacesBatch).not.toHaveBeenCalled();
  });
});
