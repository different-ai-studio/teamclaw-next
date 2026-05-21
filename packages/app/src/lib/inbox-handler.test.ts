import { describe, it, expect, vi } from "vitest";
import { handleInboxEnvelope, type InboxStore } from "./inbox-handler";

function makeEnv(topic: string, payload: unknown): { topic: string; bytes: number[] } {
  const text = JSON.stringify(payload);
  return { topic, bytes: Array.from(new TextEncoder().encode(text)) };
}

function makeStore(rowIds: string[]): InboxStore & {
  patchRow: ReturnType<typeof vi.fn>;
  loadFirstPage: ReturnType<typeof vi.fn>;
} {
  return {
    rows: rowIds.map((id) => ({ id })),
    patchRow: vi.fn(),
    loadFirstPage: vi.fn(async () => {}),
  };
}

describe("handleInboxEnvelope", () => {
  it("patches has_unread for a session already in the cache", () => {
    const store = makeStore(["s1", "s2"]);
    handleInboxEnvelope(
      makeEnv("inbox/u1", { session_id: "s1", ts: 12345 }),
      "u1",
      store,
    );
    expect(store.patchRow).toHaveBeenCalledWith("s1", { has_unread: true });
    expect(store.loadFirstPage).not.toHaveBeenCalled();
  });

  it("refreshes the first page when session is not in cache", () => {
    const store = makeStore(["s1"]);
    handleInboxEnvelope(
      makeEnv("inbox/u1", { session_id: "newsession" }),
      "u1",
      store,
    );
    expect(store.patchRow).not.toHaveBeenCalled();
    expect(store.loadFirstPage).toHaveBeenCalledOnce();
  });

  it("ignores pings for a different user (defensive, broker ACL should also block)", () => {
    const store = makeStore(["s1"]);
    const logger = { warn: vi.fn() };
    handleInboxEnvelope(
      makeEnv("inbox/other-user", { session_id: "s1" }),
      "u1",
      store,
      logger,
    );
    expect(store.patchRow).not.toHaveBeenCalled();
    expect(store.loadFirstPage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("silently ignores non-inbox topics (other MQTT traffic flows through same listener)", () => {
    const store = makeStore(["s1"]);
    const logger = { warn: vi.fn() };
    handleInboxEnvelope(
      makeEnv("amux/t1/session/s1/live", { session_id: "s1" }),
      "u1",
      store,
      logger,
    );
    expect(store.patchRow).not.toHaveBeenCalled();
    expect(store.loadFirstPage).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns on unparseable payload", () => {
    const store = makeStore(["s1"]);
    const logger = { warn: vi.fn() };
    handleInboxEnvelope(
      { topic: "inbox/u1", bytes: [0xff, 0xfe, 0xfd, 0x00] },
      "u1",
      store,
      logger,
    );
    expect(store.patchRow).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("warns on payload missing session_id", () => {
    const store = makeStore(["s1"]);
    const logger = { warn: vi.fn() };
    handleInboxEnvelope(makeEnv("inbox/u1", { ts: 123 }), "u1", store, logger);
    expect(store.patchRow).not.toHaveBeenCalled();
    expect(store.loadFirstPage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});
