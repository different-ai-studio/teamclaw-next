// Outbox sender — ports iOS `OutboxSender` to the Tauri/web client.
//
// Loop: every TICK_MS, fetch due rows (state=pending && nextAttemptAt <= now)
// from `useOutboxStore`, run `attempt()` on each. On success → state=delivered
// (UI shows check, row is GC'd after the next tick). On failure → bump
// attempt_count, schedule next nextAttemptAt with exponential backoff
// (`outboxBackoffMs`), or transition to `failed` once `OUTBOX_MAX_ATTEMPTS`
// hit (user can click the bubble's error dot to call `useOutboxStore.retry`).
//
// The sender is a singleton — `startOutboxSender()` is idempotent and should
// be called once on app boot after the outbox store is hydrated.

import { create as createMessage, toBinary } from "@bufbuild/protobuf";
import { supabase } from "@/lib/supabase-client";
import {
  LiveEventEnvelopeSchema,
  MessageKind,
  MessageSchema,
  SessionMessageEnvelopeSchema,
} from "@/lib/proto/teamclaw_pb";
import { mqttPublish } from "@/lib/mqtt-bridge";
import {
  OUTBOX_MAX_ATTEMPTS,
  outboxBackoffMs,
  useOutboxStore,
  type OutboxEntry,
} from "@/stores/outbox-store";

const TICK_MS = 1000;
const DELIVERED_GC_MS = 5000;

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
let inflightTick = false;

async function attempt(entry: OutboxEntry): Promise<void> {
  const store = useOutboxStore.getState();
  const now = new Date().toISOString();

  await store.updateState(entry.messageId, {
    state: "inFlight",
    lastAttemptAt: now,
  });

  try {
    const createdAtSec = BigInt(
      Math.floor(new Date(entry.createdAt).getTime() / 1000),
    );

    const proto = createMessage(MessageSchema, {
      messageId: entry.messageId,
      sessionId: entry.sessionId,
      senderActorId: entry.senderActorId,
      kind: MessageKind.TEXT,
      content: entry.content,
      createdAt: createdAtSec,
    });
    const sessionEnv = createMessage(SessionMessageEnvelopeSchema, {
      message: proto,
      mentionActorIds: entry.mentionActorIds,
    });
    const live = createMessage(LiveEventEnvelopeSchema, {
      eventId: crypto.randomUUID(),
      eventType: "message.created",
      sessionId: entry.sessionId,
      actorId: entry.senderActorId,
      sentAt: createdAtSec,
      body: toBinary(SessionMessageEnvelopeSchema, sessionEnv),
    });

    const { error: insErr } = await supabase.from("messages").insert({
      id: entry.messageId,
      team_id: entry.teamId,
      session_id: entry.sessionId,
      sender_actor_id: entry.senderActorId,
      kind: "text",
      content: entry.content,
      metadata: {
        mention_actor_ids: entry.mentionActorIds,
        ...(entry.attachmentUrls.length > 0
          ? { attachment_urls: entry.attachmentUrls }
          : {}),
      },
    });

    // Supabase unique-constraint violation on `id` means this same message
    // already landed on a prior attempt (the network round-trip dropped
    // before we got the ACK). Treat as success — the row is persisted.
    if (insErr && insErr.code !== "23505") throw insErr;

    await mqttPublish(
      `amux/${entry.teamId}/session/${entry.sessionId}/live`,
      toBinary(LiveEventEnvelopeSchema, live),
      false,
    ).catch((err) => {
      // MQTT publish failure shouldn't fail the send — Supabase is the
      // source of truth and other clients hydrate from there. Just log.
      console.warn("[outbox] MQTT publish failed (best-effort):", err);
    });

    await store.updateState(entry.messageId, {
      state: "delivered",
      lastError: null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const nextAttempt = entry.attemptCount + 1;
    if (nextAttempt >= OUTBOX_MAX_ATTEMPTS) {
      await store.updateState(entry.messageId, {
        state: "failed",
        attemptCount: nextAttempt,
        lastError: msg,
        nextAttemptAt: null,
      });
    } else {
      const next = new Date(Date.now() + outboxBackoffMs(nextAttempt));
      await store.updateState(entry.messageId, {
        state: "pending",
        attemptCount: nextAttempt,
        lastError: msg,
        nextAttemptAt: next.toISOString(),
      });
    }
  }
}

async function tick(): Promise<void> {
  if (inflightTick) return;
  inflightTick = true;
  try {
    const nowMs = Date.now();
    const due: OutboxEntry[] = [];
    const deliveredToGc: string[] = [];

    for (const entry of Object.values(useOutboxStore.getState().byId)) {
      if (entry.state === "pending") {
        const due_at = entry.nextAttemptAt
          ? new Date(entry.nextAttemptAt).getTime()
          : 0;
        if (due_at <= nowMs) due.push(entry);
      } else if (entry.state === "delivered") {
        const since = nowMs - new Date(entry.updatedAt).getTime();
        if (since >= DELIVERED_GC_MS) deliveredToGc.push(entry.messageId);
      }
    }

    for (const id of deliveredToGc) {
      await useOutboxStore.getState().remove(id);
    }

    // Run sequentially — keeps Supabase load bounded and avoids interleaved
    // state transitions for the same row across overlapping attempts.
    for (const e of due) await attempt(e);
  } finally {
    inflightTick = false;
  }
}

/** Start the outbox sender loop. Idempotent — safe to call multiple times. */
export function startOutboxSender(): void {
  if (started) return;
  started = true;
  // Fire one tick immediately so a freshly-enqueued message goes out without
  // waiting up to TICK_MS — feels responsive.
  void tick();
  timer = setInterval(() => void tick(), TICK_MS);
}

/** Stop the loop. Useful in tests; not normally called in production. */
export function stopOutboxSender(): void {
  if (!started) return;
  started = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
