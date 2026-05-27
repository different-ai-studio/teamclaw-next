import { describe, expect, it } from "vitest";
import { createSessionsModule } from "../sessions";
import type { CloudApiClient } from "../http";
import type { SessionsBackend } from "../../types";

function mockClient(responses: Record<string, unknown>): CloudApiClient {
  return {
    async get(path) {
      const key = Object.keys(responses).find((k) => k === `GET ${path}` || (k.startsWith("GET ") && path.startsWith(k.replace("GET ", ""))));
      if (key) return responses[key] as never;
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path, body) {
      const key = `POST ${path}`;
      if (key in responses) return responses[key] as never;
      throw new Error(`unexpected POST ${path}`);
    },
    async patch() { throw new Error("unexpected patch"); },
    async delete() { throw new Error("unexpected delete"); },
    async postRaw() { throw new Error("not impl"); },
    async getRaw() { throw new Error("not impl"); },
  } as unknown as CloudApiClient;
}

const fakeDelegate = (): SessionsBackend => ({
  listCurrentActorSessions: async () => ({ rows: [] }),
  markCurrentActorSessionViewed: async () => {},
  createSessionShell: async () => ({ sessionId: "s1" }),
  addParticipants: async () => {},
  updateSessionTitle: async () => {},
  archiveSession: async () => {},
  getSessionParticipants: async () => [],
  getSessionTeamId: async () => null,
  listSessionsForTeamSince: async () => [],
  listSessionDisplayRows: async () => [],
});

const cloudSession = {
  id: "session-1",
  teamId: "team-1",
  title: "Plan",
  mode: "collab",
  ideaId: null,
  lastMessageAt: "2026-05-01T00:00:00Z",
  lastMessagePreview: "hello",
  hasUnread: true,
  createdAt: "2026-05-01T00:00:00Z",
  updatedAt: "2026-05-01T01:00:00Z",
};

describe("sessions module", () => {
  it("listCurrentActorSessions calls /v1/sessions and maps fields", async () => {
    const client = mockClient({ "GET /v1/sessions?limit=50": { items: [cloudSession], nextCursor: null } });
    const mod = createSessionsModule(client, fakeDelegate());
    const out = await mod.listCurrentActorSessions({ limit: 50, cursor: null });
    expect(out.rows[0].id).toBe("session-1");
    expect(out.rows[0].team_id).toBe("team-1");
    expect(out.rows[0].has_unread).toBe(true);
  });

  it("markCurrentActorSessionViewed calls POST /v1/sessions/:id/mark-viewed", async () => {
    let called = false;
    const client = {
      async get() { throw new Error("unexpected"); },
      async post(path: string) { called = true; expect(path).toBe("/v1/sessions/session-1/mark-viewed"); return null; },
      async patch() { throw new Error("unexpected"); },
      async delete() { throw new Error("unexpected"); },
      async postRaw() { throw new Error("unexpected"); },
      async getRaw() { throw new Error("unexpected"); },
    } as unknown as CloudApiClient;
    const mod = createSessionsModule(client, fakeDelegate());
    await mod.markCurrentActorSessionViewed("session-1");
    expect(called).toBe(true);
  });

  it("delegates createSessionShell to supabase", async () => {
    let delegateCalled = false;
    const delegate = fakeDelegate();
    delegate.createSessionShell = async () => { delegateCalled = true; return { sessionId: "s2" }; };
    const client = mockClient({});
    const mod = createSessionsModule(client, delegate);
    const out = await mod.createSessionShell({ id: "s2", teamId: "t1", createdByActorId: "a1", title: "T", additionalActorIds: [] });
    expect(delegateCalled).toBe(true);
    expect(out.sessionId).toBe("s2");
  });
});
