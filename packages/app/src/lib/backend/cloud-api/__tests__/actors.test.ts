import { describe, expect, it } from "vitest";
import { createActorsModule } from "../actors";
import type { CloudApiClient } from "../http";
import type { ActorsBackend } from "../../types";

function mockClient(responses: Record<string, unknown>): CloudApiClient {
  return {
    async get(path) {
      const key = Object.keys(responses).find((k) => k.startsWith("GET ") && (k === `GET ${path}` || path.startsWith(k.replace("GET ", ""))));
      if (key) return responses[key] as never;
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path, body) {
      const key = `POST ${path}`;
      if (key in responses) return responses[key] as never;
      throw new Error(`unexpected POST ${path}`);
    },
    async patch(path) {
      const key = Object.keys(responses).find((k) => k === `PATCH ${path}` || (k.startsWith("PATCH ") && path.startsWith(k.replace("PATCH ", ""))));
      if (key) return responses[key] as never;
      return undefined as never;
    },
    async delete(path) { return undefined as never; },
    async postRaw() { throw new Error("not impl"); },
    async getRaw() { throw new Error("not impl"); },
  } as unknown as CloudApiClient;
}

const fakeDelegate = (): ActorsBackend => ({
  listActorDirectory: async () => [],
  listActorDirectoryByIds: async () => [],
  getActorDirectoryEntry: async () => null,
  getDaemonAgentDirectoryEntry: async () => null,
  listConnectedAgents: async () => [],
  updateOwnedAgentProfile: async () => {},
  updateAgentDefaults: async () => {},
  listAgentAccess: async () => [],
  listTeamMembersForAccess: async () => [],
  upsertAgentAccess: async () => {},
  removeAgentAccess: async () => {},
});

const cloudActor = { id: "actor-1", teamId: "team-1", kind: "member", displayName: "Alice", avatarUrl: null };

describe("actors module", () => {
  it("listActorDirectory calls /v1/teams/:teamId/actors and maps fields", async () => {
    const client = mockClient({ "GET /v1/teams/team-1/actors?limit=500": { items: [cloudActor], nextCursor: null } });
    const mod = createActorsModule(client, fakeDelegate());
    const out = await mod.listActorDirectory("team-1");
    expect(out[0].id).toBe("actor-1");
    expect(out[0].team_id).toBe("team-1");
    expect(out[0].actor_type).toBe("member");
    expect(out[0].display_name).toBe("Alice");
  });

  it("listConnectedAgents calls /v1/teams/:teamId/agents/connected", async () => {
    const cloudAgent = { ...cloudActor, kind: "agent", agentId: "a-1", deviceId: "dev-1" };
    const client = mockClient({ "GET /v1/teams/team-1/agents/connected": { items: [cloudAgent] } });
    const mod = createActorsModule(client, fakeDelegate());
    const out = await mod.listConnectedAgents("team-1");
    expect(out[0].id).toBe("actor-1");
    expect(out[0].agent_id).toBe("a-1");
  });

  it("listActorDirectoryByIds delegates to supabase for empty list", async () => {
    const client = mockClient({});
    const mod = createActorsModule(client, fakeDelegate());
    const out = await mod.listActorDirectoryByIds([]);
    expect(out).toEqual([]);
  });
});
