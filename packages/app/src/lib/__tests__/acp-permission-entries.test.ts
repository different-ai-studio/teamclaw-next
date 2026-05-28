import { describe, expect, it } from "vitest";
import {
  buildPendingEntryFromAcpPermission,
  collectAcpStreamingPermissions,
} from "@/lib/teamclaw/acp-permission-entries";

describe("acp permission entries", () => {
  it("maps bash tool permission for the approval card", () => {
    const entry = buildPendingEntryFromAcpPermission("sess-1", "agent-1", {
      requestId: "perm-1",
      toolName: "bash",
      description: "ls -la",
      params: { command: "ls -la" },
    });
    expect(entry.permission.id).toBe("perm-1");
    expect(entry.permission.permission).toBe("bash");
    expect(entry.permission.patterns).toEqual(["ls -la"]);
    expect(entry.permission.metadata?._acp_agent_actor_id).toBe("agent-1");
  });

  it("collects pending permissions for the active session only", () => {
    const rows = collectAcpStreamingPermissions("sess-a", {
      "sess-a::agent-1": {
        sessionId: "sess-a",
        actorId: "agent-1",
        pendingPermission: {
          requestId: "p1",
          toolName: "Bash",
          description: "echo hi",
          params: {},
        },
      },
      "sess-b::agent-2": {
        sessionId: "sess-b",
        actorId: "agent-2",
        pendingPermission: {
          requestId: "p2",
          toolName: "bash",
          description: "pwd",
          params: {},
        },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.permission.id).toBe("p1");
  });
});
