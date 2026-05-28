import { describe, expect, it } from "vitest";
import { createMessagesModule } from "../messages";
import type { CloudApiClient } from "../http";
import type { MessagesBackend } from "../../types";

function mockClient(responses: Record<string, unknown>): CloudApiClient {
  return {
    async get(path) {
      const key = `GET ${path}`;
      if (key in responses) return responses[key] as never;
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path, body, opts) {
      const key = `POST ${path}`;
      if (key in responses) return responses[key] as never;
      throw new Error(`unexpected POST ${path}`);
    },
    async patch(path, body) {
      const key = `PATCH ${path}`;
      if (key in responses) return responses[key] as never;
      throw new Error(`unexpected PATCH ${path}`);
    },
    async delete() { throw new Error("unexpected delete"); },
    async postRaw() { throw new Error("not impl"); },
    async getRaw() { throw new Error("not impl"); },
  } as unknown as CloudApiClient;
}

const fakeDelegate = (): MessagesBackend => ({
  insertOutgoingMessage: async () => ({ id: "x", team_id: "t", session_id: "s", turn_id: null, sender_actor_id: null, reply_to_message_id: null, kind: "text", content: "", metadata: null, created_at: "", updated_at: null }),
  listMessages: async () => [],
  updateMessageContent: async () => {},
  listMessagesForSessionSince: async () => [],
});

const cloudMessage = {
  id: "message-1",
  teamId: "team-1",
  sessionId: "session-1",
  turnId: null,
  senderActorId: "actor-1",
  replyToMessageId: null,
  kind: "text",
  content: "hello",
  metadata: null,
  model: null,
  createdAt: "2026-05-01T00:00:00Z",
  updatedAt: null,
};

describe("messages module", () => {
  it("listMessages calls /v1/sessions/:id/messages and maps fields", async () => {
    const client = mockClient({ "GET /v1/sessions/session-1/messages": { items: [cloudMessage], nextCursor: null } });
    const mod = createMessagesModule(client, fakeDelegate());
    const out = await mod.listMessages("session-1");
    expect(out[0].id).toBe("message-1");
    expect(out[0].team_id).toBe("team-1");
    expect(out[0].sender_actor_id).toBe("actor-1");
  });

  it("insertOutgoingMessage calls POST and returns mapped message", async () => {
    const client = mockClient({ "POST /v1/sessions/session-1/messages": cloudMessage });
    const mod = createMessagesModule(client, fakeDelegate());
    const out = await mod.insertOutgoingMessage({
      id: "message-1",
      teamId: "team-1",
      sessionId: "session-1",
      senderActorId: "actor-1",
      content: "hello",
    });
    expect(out.id).toBe("message-1");
  });

  it("updateMessageContent calls PATCH /v1/messages/:id", async () => {
    const client = mockClient({ "PATCH /v1/messages/message-1": cloudMessage });
    const mod = createMessagesModule(client, fakeDelegate());
    await expect(mod.updateMessageContent("message-1", "updated")).resolves.toBeUndefined();
  });
});
