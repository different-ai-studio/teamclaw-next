import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseAttachmentsBackend } from "../attachments";
import { createSupabaseMessagesBackend } from "../messages";
import { createSupabaseRuntimeBackend } from "../runtime";
import type { MessageHistoryRow, MessageSyncRow } from "../../types";

const messageColumns =
  "id, team_id, session_id, turn_id, sender_actor_id, reply_to_message_id, kind, content, metadata, model, created_at, updated_at, attachments";
const messageSyncColumns =
  "id, team_id, session_id, turn_id, sender_actor_id, reply_to_message_id, kind, content, metadata, model, created_at, updated_at";

describe("Supabase messages backend", () => {
  let client: { from: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    client = { from: vi.fn() };
  });

  it("inserts outgoing messages using Supabase column names", async () => {
    const row = {
      id: "message-1",
      team_id: "team-1",
      session_id: "session-1",
      turn_id: "turn-1",
      sender_actor_id: "actor-1",
      reply_to_message_id: null,
      kind: "text",
      content: "hello",
      metadata: { mention_actor_ids: [] },
      model: "model-1",
      created_at: "2026-05-25T00:00:00.000Z",
      updated_at: "2026-05-25T00:00:00.000Z",
      attachments: [{ attachmentId: "att-1" }],
    };
    const single = vi.fn().mockResolvedValueOnce({ data: row, error: null });
    const select = vi.fn(() => ({ single }));
    const insert = vi.fn(() => ({ select }));
    client.from.mockReturnValueOnce({ insert });

    const result = await createSupabaseMessagesBackend(client).insertOutgoingMessage({
      id: "message-1",
      teamId: "team-1",
      sessionId: "session-1",
      senderActorId: "actor-1",
      content: "hello",
      model: "model-1",
      metadata: { mention_actor_ids: [] },
      turnId: "turn-1",
      attachments: [{ attachmentId: "att-1", fileName: "a.txt", signedUrl: "https://x", mimeType: "text/plain", size: 1 }],
      createdAt: "2026-05-25T00:00:00.000Z",
    });

    expect(client.from).toHaveBeenCalledWith("messages");
    expect(insert).toHaveBeenCalledWith({
      id: "message-1",
      team_id: "team-1",
      session_id: "session-1",
      sender_actor_id: "actor-1",
      kind: "text",
      content: "hello",
      metadata: { mention_actor_ids: [] },
      model: "model-1",
      turn_id: "turn-1",
      reply_to_message_id: null,
      attachments: [{ attachmentId: "att-1", fileName: "a.txt", signedUrl: "https://x", mimeType: "text/plain", size: 1 }],
      created_at: "2026-05-25T00:00:00.000Z",
    });
    expect(select).toHaveBeenCalledWith(messageColumns);
    expect(result).toBe(row);
  });

  it("lists messages ordered by creation time and id", async () => {
    const rows: MessageHistoryRow[] = [{
      id: "message-1",
      team_id: "team-1",
      session_id: "session-1",
      turn_id: null,
      sender_actor_id: null,
      reply_to_message_id: null,
      kind: "text",
      content: "actor was deleted",
      metadata: null,
      model: null,
      attachments: null,
      created_at: "2026-05-25T00:00:00.000Z",
      updated_at: "2026-05-25T00:00:00.000Z",
    }];
    const secondOrder = vi.fn().mockResolvedValueOnce({ data: rows, error: null });
    const firstOrder = vi.fn(() => ({ order: secondOrder }));
    const eq = vi.fn(() => ({ order: firstOrder }));
    const select = vi.fn(() => ({ eq }));
    client.from.mockReturnValueOnce({ select });

    const result = await createSupabaseMessagesBackend(client).listMessages("session-1");

    expect(select).toHaveBeenCalledWith(messageColumns);
    expect(eq).toHaveBeenCalledWith("session_id", "session-1");
    expect(firstOrder).toHaveBeenCalledWith("created_at", { ascending: true });
    expect(secondOrder).toHaveBeenCalledWith("id", { ascending: true });
    expect(result).toBe(rows);
    expect(result[0].sender_actor_id).toBeNull();
  });

  it("updates message content and updated_at", async () => {
    const eq = vi.fn().mockResolvedValueOnce({ error: null });
    const update = vi.fn(() => ({ eq }));
    client.from.mockReturnValueOnce({ update });

    await createSupabaseMessagesBackend(client).updateMessageContent("message-1", "new text");

    expect(update).toHaveBeenCalledWith({
      content: "new text",
      updated_at: expect.any(String),
    });
    expect(eq).toHaveBeenCalledWith("id", "message-1");
  });

  it("lists messages changed since a timestamp when provided", async () => {
    const rows = [{
      id: "message-1",
      team_id: "team-1",
      session_id: "session-1",
      turn_id: null,
      sender_actor_id: null,
      reply_to_message_id: null,
      kind: "text",
      content: "actor was deleted",
      metadata: { source: "sync" },
      model: null,
      created_at: "2026-05-25T00:00:00.000Z",
      updated_at: "2026-05-25T00:01:00.000Z",
    }] satisfies MessageSyncRow[];
    const gt = vi.fn().mockResolvedValueOnce({ data: rows, error: null });
    const eq = vi.fn(() => ({ gt }));
    const select = vi.fn(() => ({ eq }));
    client.from.mockReturnValueOnce({ select });

    const result = await createSupabaseMessagesBackend(client).listMessagesForSessionSince(
      "session-1",
      "2026-05-25T00:00:00.000Z",
    );

    expect(select).toHaveBeenCalledWith(messageSyncColumns);
    expect(eq).toHaveBeenCalledWith("session_id", "session-1");
    expect(gt).toHaveBeenCalledWith("updated_at", "2026-05-25T00:00:00.000Z");
    expect(result).toBe(rows);
    expect(result[0]).not.toHaveProperty("attachments");
    expect(result[0].updated_at).toBe("2026-05-25T00:01:00.000Z");
  });
});

describe("Supabase runtime backend", () => {
  let client: { from: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    client = { from: vi.fn() };
  });

  it("returns no runtime hints when there are no agents", async () => {
    const result = await createSupabaseRuntimeBackend(client).listLatestAgentRuntimeHints("team-1", []);

    expect(result).toEqual([]);
    expect(client.from).not.toHaveBeenCalled();
  });

  it("lists latest runtime hints for agents in a team", async () => {
    const rows = [{ id: "row-1", agent_id: "agent-1" }];
    const order = vi.fn().mockResolvedValueOnce({ data: rows, error: null });
    const eq = vi.fn(() => ({ order }));
    const inFn = vi.fn(() => ({ eq }));
    const select = vi.fn(() => ({ in: inFn }));
    client.from.mockReturnValueOnce({ select });

    const result = await createSupabaseRuntimeBackend(client).listLatestAgentRuntimeHints("team-1", ["agent-1"]);

    expect(client.from).toHaveBeenCalledWith("agent_runtimes");
    expect(select).toHaveBeenCalledWith(
      "id, agent_id, workspace_id, backend_type, runtime_id, session_id, status, current_model, updated_at",
    );
    expect(inFn).toHaveBeenCalledWith("agent_id", ["agent-1"]);
    expect(eq).toHaveBeenCalledWith("team_id", "team-1");
    expect(order).toHaveBeenCalledWith("updated_at", { ascending: false });
    expect(result).toBe(rows);
  });

  it("lists agent defaults", async () => {
    const rows = [{ id: "agent-1", agent_types: ["codex"], default_agent_type: "codex" }];
    const inFn = vi.fn().mockResolvedValueOnce({ data: rows, error: null });
    const select = vi.fn(() => ({ in: inFn }));
    client.from.mockReturnValueOnce({ select });

    const result = await createSupabaseRuntimeBackend(client).listAgentDefaults(["agent-1"]);

    expect(client.from).toHaveBeenCalledWith("agents");
    expect(select).toHaveBeenCalledWith("id, agent_types, default_agent_type");
    expect(inFn).toHaveBeenCalledWith("id", ["agent-1"]);
    expect(result).toBe(rows);
  });

  it("updates runtime current_model and updated_at", async () => {
    const eq = vi.fn().mockResolvedValueOnce({ error: null });
    const update = vi.fn(() => ({ eq }));
    client.from.mockReturnValueOnce({ update });

    await createSupabaseRuntimeBackend(client).updateRuntimeModel("runtime-row-1", "model-1");

    expect(client.from).toHaveBeenCalledWith("agent_runtimes");
    expect(update).toHaveBeenCalledWith({
      current_model: "model-1",
      updated_at: expect.any(String),
    });
    expect(eq).toHaveBeenCalledWith("id", "runtime-row-1");
  });

  it("lists session runtime model rows ordered by recency", async () => {
    const rows = [{ runtime_id: "rt-1", backend_type: "codex", current_model: "gpt-5" }];
    const order = vi.fn().mockResolvedValue({ data: rows, error: null });
    const eq = vi.fn(() => ({ order }));
    const select = vi.fn(() => ({ eq }));
    client.from.mockReturnValueOnce({ select });

    const result = await createSupabaseRuntimeBackend(client).listSessionRuntimeModels("session-1");

    expect(client.from).toHaveBeenCalledWith("agent_runtimes");
    expect(select).toHaveBeenCalledWith("runtime_id, backend_type, current_model, updated_at");
    expect(eq).toHaveBeenCalledWith("session_id", "session-1");
    expect(order).toHaveBeenCalledWith("updated_at", { ascending: false });
    expect(result).toBe(rows);
  });

  it("lists runtime targets for a session and optional agents", async () => {
    const rows = [{ agent_id: "agent-1", runtime_id: "rt-1" }];
    const inFn = vi.fn().mockResolvedValue({ data: rows, error: null });
    const eq = vi.fn(() => ({ in: inFn }));
    const select = vi.fn(() => ({ eq }));
    client.from.mockReturnValueOnce({ select });

    const result = await createSupabaseRuntimeBackend(client).listRuntimeTargetsForSession("session-1", ["agent-1"]);

    expect(client.from).toHaveBeenCalledWith("agent_runtimes");
    expect(select).toHaveBeenCalledWith("agent_id, runtime_id");
    expect(eq).toHaveBeenCalledWith("session_id", "session-1");
    expect(inFn).toHaveBeenCalledWith("agent_id", ["agent-1"]);
    expect(result).toBe(rows);
  });

  it("lists all runtime targets for a session without an agent filter", async () => {
    const rows = [{ agent_id: "agent-1", runtime_id: "rt-1" }];
    const eq = vi.fn().mockResolvedValue({ data: rows, error: null });
    const select = vi.fn(() => ({ eq }));
    client.from.mockReturnValueOnce({ select });

    const result = await createSupabaseRuntimeBackend(client).listRuntimeTargetsForSession("session-1", []);

    expect(result).toBe(rows);
  });

  it("lists daemon runtime rows for a team", async () => {
    const rows = [{ id: "runtime-row-1", team_id: "team-1", agent_id: "agent-1" }];
    const order = vi.fn().mockResolvedValue({ data: rows, error: null });
    const eq = vi.fn(() => ({ order }));
    const select = vi.fn(() => ({ eq }));
    client.from.mockReturnValueOnce({ select });

    const result = await createSupabaseRuntimeBackend(client).listDaemonRuntimes("team-1");

    expect(client.from).toHaveBeenCalledWith("agent_runtimes");
    expect(select).toHaveBeenCalledWith(
      "id, runtime_id, team_id, agent_id, session_id, workspace_id, backend_type, backend_session_id, status, current_model, last_seen_at, created_at, updated_at",
    );
    expect(eq).toHaveBeenCalledWith("team_id", "team-1");
    expect(order).toHaveBeenCalledWith("updated_at", { ascending: false });
    expect(result).toBe(rows);
  });
});

describe("Supabase attachments backend", () => {
  it("uploads to the attachments bucket and returns a signed attachment ref", async () => {
    const upload = vi.fn().mockResolvedValueOnce({ error: null });
    const createSignedUrl = vi.fn().mockResolvedValueOnce({
      data: { signedUrl: "https://signed.example/file.txt" },
      error: null,
    });
    const from = vi.fn(() => ({ upload, createSignedUrl }));
    const client = { storage: { from } };
    const file = new File(["hello"], "file.txt", { type: "text/plain" });
    vi.spyOn(crypto, "randomUUID").mockReturnValueOnce("attachment-1");

    const result = await createSupabaseAttachmentsBackend(client).uploadAttachment({
      file,
      teamId: "team-1",
      sessionId: "session-1",
    });

    expect(from).toHaveBeenCalledWith("attachments");
    expect(upload).toHaveBeenCalledWith(
      "team-1/session-1/attachment-1/file.txt",
      file,
      { contentType: "text/plain", upsert: false },
    );
    expect(createSignedUrl).toHaveBeenCalledWith(
      "team-1/session-1/attachment-1/file.txt",
      31_536_000,
    );
    expect(result).toEqual({
      attachmentId: "attachment-1",
      fileName: "file.txt",
      signedUrl: "https://signed.example/file.txt",
      mimeType: "text/plain",
      size: file.size,
    });
  });

  it("rejects when Supabase signs without returning a signed URL", async () => {
    const upload = vi.fn().mockResolvedValueOnce({ error: null });
    const createSignedUrl = vi.fn().mockResolvedValueOnce({
      data: null,
      error: null,
    });
    const from = vi.fn(() => ({ upload, createSignedUrl }));
    const client = { storage: { from } };
    const file = new File(["hello"], "file.txt", { type: "text/plain" });
    vi.spyOn(crypto, "randomUUID").mockReturnValueOnce("attachment-2");

    await expect(createSupabaseAttachmentsBackend(client).uploadAttachment({
      file,
      teamId: "team-1",
      sessionId: "session-1",
    })).rejects.toThrow(/signed URL missing/i);
  });
});
