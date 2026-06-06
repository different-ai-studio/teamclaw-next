// packages/app/src/lib/inbox-handler.ts
//
// Handles incoming MQTT pings on `inbox/<user_id>` (published by FC fan-out
// after each message INSERT or mark-viewed). The payload shape:
//   { type?: "message" | "read", session_id, ts }
// `type` is optional for backward compatibility — absent means "message".

export interface InboxPing {
  session_id: string;
  type?: "message" | "read";
  ts?: number;
}

export interface InboxEnvelope {
  topic: string;
  bytes: number[];
}

/**
 * Minimum slice of the session-list store this handler depends on.
 * Kept as an interface so the handler stays a pure function and tests
 * don't need to spin up zustand.
 */
export interface InboxStore {
  rows: ReadonlyArray<{ id: string }>;
  patchRow: (sessionId: string, patch: { has_unread: boolean }) => void;
  loadFirstPage: () => Promise<void>;
}

export function handleInboxEnvelope(
  env: InboxEnvelope,
  expectedUserId: string,
  store: InboxStore,
  logger: Pick<Console, "warn"> = console,
): void {
  const prefix = "inbox/";
  if (!env.topic.startsWith(prefix)) return; // not for us, silently skip
  const topicUser = env.topic.slice(prefix.length);
  if (topicUser !== expectedUserId) {
    logger.warn("[inbox] ping for different user", { topicUser, expectedUserId });
    return;
  }

  let payload: InboxPing;
  try {
    const text = new TextDecoder().decode(new Uint8Array(env.bytes));
    payload = JSON.parse(text);
  } catch (e) {
    logger.warn("[inbox] failed to parse payload", e);
    return;
  }
  if (!payload || typeof payload.session_id !== "string") {
    logger.warn("[inbox] missing session_id", payload);
    return;
  }

  if (payload.type === "read") {
    // Another device marked this session read — clear the unread dot locally.
    store.patchRow(payload.session_id, { has_unread: false });
    return;
  }

  // type === "message" or absent (legacy) — mark session unread.
  const found = store.rows.some((r) => r.id === payload.session_id);
  if (found) {
    // Cheap optimistic update. The next list refresh confirms server state.
    store.patchRow(payload.session_id, { has_unread: true });
  } else {
    // New session not in cached rows — full refresh.
    void store.loadFirstPage();
  }
}
