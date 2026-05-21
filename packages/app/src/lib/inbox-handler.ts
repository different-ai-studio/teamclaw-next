// packages/app/src/lib/inbox-handler.ts
//
// Handles incoming MQTT pings on `inbox/<user_id>` (published by FC fan-out
// after each message INSERT). The payload is intentionally minimal —
// `{ session_id, ts }` — because `has_unread` is recomputed server-side
// from `session_read_markers` + `sessions.last_message_at`. The client just
// needs to know "something changed for this session" and update the UI.

export interface InboxPing {
  session_id: string;
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

  const found = store.rows.some((r) => r.id === payload.session_id);
  if (found) {
    // Cheap optimistic update. The next list refresh confirms server state.
    store.patchRow(payload.session_id, { has_unread: true });
  } else {
    // New session not in cached rows — full refresh.
    void store.loadFirstPage();
  }
}
