# Expo / iOS Parity Batch 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Expo (Android) client to 1:1 parity with iOS on four behaviors — durable outbox with retry, multi-agent streaming reducer, in-app ShortcutWebView, and a ConnectedAgentsStore that subscribes to runtime/+/state MQTT.

**Architecture:** Two shared singletons (`expo-sqlite` DB + team-scoped MQTT client) get created first. Each of the four feature blocks layers on top with the same controller/store/DAO pattern already used elsewhere in `apps/expo`. The existing `session-detail-controller` is refactored once to consume the shared MQTT client so the per-session and per-team subscribers fan out from one TCP connection.

**Tech Stack:** Expo Router · React Native · TypeScript · `expo-sqlite` · `react-native-webview` · `mqtt` (mqtt.js) · `@bufbuild/protobuf` · `@supabase/supabase-js` · Vitest

**Spec:** [`docs/superpowers/specs/2026-05-20-expo-ios-parity-batch-2-design.md`](../specs/2026-05-20-expo-ios-parity-batch-2-design.md)

---

## File Structure

### Shared infrastructure (Phase 0)
- Create: `apps/expo/src/lib/db/sqlite.ts` — singleton DB opener with WAL + migration runner
- Create: `apps/expo/src/lib/db/migrations.ts` — versioned migrations, one row per version
- Create: `apps/expo/src/lib/mqtt/team-mqtt.ts` — team-scoped MQTT client with wildcard-aware topic dispatcher
- Create: `apps/expo/src/lib/mqtt/topic-match.ts` — pure helper matching `amux/+/device/+/runtime/+/state` style filters

### Section A — Outbox
- Create: `apps/expo/src/features/sessions/outbox-db.ts` — DAO over `outbox` table
- Create: `apps/expo/src/features/sessions/outbox-backoff.ts` — pure backoff fn
- Create: `apps/expo/src/features/sessions/outbox-sender.ts` — 1s poll loop + retry
- Modify: `apps/expo/src/features/sessions/outbox-store.ts` — UI subscription layer reads from DAO
- Modify: `apps/expo/src/features/sessions/session-detail-controller.ts` — `sendMessage` enqueues; sender lifecycle bound to `load`/`dispose`
- Modify: `apps/expo/src/features/sessions/components/SessionMessageRow.tsx` — tap on failed dot → retry callback

### Section B — Timeline reducer
- Create: `apps/expo/src/features/sessions/timeline-reducer.ts` — pure reducer + types
- Modify: `apps/expo/src/features/sessions/session-types.ts` — `StreamingBuffer` type, `streamingByAgent` on controller state
- Modify: `apps/expo/src/features/sessions/session-detail-controller.ts` — replace `mergeMessage` with reducer
- Modify: `apps/expo/src/features/sessions/components/SessionMessageRow.tsx` — `isStreaming` prop + cursor
- Modify: `apps/expo/src/features/sessions/screens/SessionDetailScreen.tsx` — append virtual streaming rows

### Section C — ShortcutWebView
- Modify: `apps/expo/package.json` — add `react-native-webview`
- Modify: `apps/expo/app/(app)/_layout.tsx` — register `shortcut-web` modal screen
- Create: `apps/expo/app/(app)/shortcut-web.tsx` — modal route
- Create: `apps/expo/src/features/shortcuts/ShortcutWebScreen.tsx` — chrome + WebView
- Modify: `apps/expo/src/features/shortcuts/ShortcutsDrawer.tsx` — route URL/external to webview

### Section D — ConnectedAgentsStore + Runtime
- Create: `apps/expo/src/features/actors/connected-agent-types.ts` — types
- Create: `apps/expo/src/features/actors/agent-access-api.ts` — Supabase RPC
- Create: `apps/expo/src/features/actors/connected-agents-cache.ts` — sqlite cache DAO
- Create: `apps/expo/src/features/actors/runtime-state-subscriber.ts` — MQTT topic watcher + proto decoder
- Create: `apps/expo/src/features/actors/connected-agents-store.ts` — state store
- Modify: `apps/expo/app/_layout.tsx` — own `TeamMqttClient` + ConnectedAgentsStore lifecycle
- Modify: `apps/expo/src/features/sessions/session-detail-controller.ts` — consume shared `TeamMqttClient`

### Tests
- Create: `apps/expo/src/test/sqlite.test.ts`
- Create: `apps/expo/src/test/topic-match.test.ts`
- Create: `apps/expo/src/test/team-mqtt.test.ts`
- Create: `apps/expo/src/test/outbox-db.test.ts`
- Create: `apps/expo/src/test/outbox-backoff.test.ts`
- Create: `apps/expo/src/test/outbox-sender.test.ts`
- Create: `apps/expo/src/test/timeline-reducer.test.ts`
- Create: `apps/expo/src/test/agent-access-api.test.ts`
- Create: `apps/expo/src/test/connected-agents-cache.test.ts`
- Create: `apps/expo/src/test/runtime-state-subscriber.test.ts`
- Create: `apps/expo/src/test/connected-agents-store.test.ts`
- Create: `apps/expo/src/test/is-agent-online.test.ts`
- Create: `apps/expo/src/test/shortcut-target.test.ts`

---

# Phase 0 — Shared Infrastructure

## Task 0.1: Add new dependencies

**Files:**
- Modify: `apps/expo/package.json`

- [ ] **Step 1: Inspect current expo SDK and pick compatible versions**

Run: `grep '"expo":' apps/expo/package.json`
Expected: `"expo": "~53.0.22"`. SDK 53 uses `expo-sqlite` 15.x and `react-native-webview` 13.x.

- [ ] **Step 2: Add deps to `apps/expo/package.json` under `dependencies`**

Insert two entries alphabetically:

```json
    "expo-sqlite": "~15.2.10",
    "react-native-webview": "13.13.5",
```

- [ ] **Step 3: Install**

Run from repo root: `pnpm install --filter @teamclaw/expo`
Expected: pnpm resolves both, lockfile updates, no peer-dep errors.

- [ ] **Step 4: Verify Metro can resolve them**

Run: `cd apps/expo && node -e "console.log(require.resolve('expo-sqlite'))"`
Then: `node -e "console.log(require.resolve('react-native-webview'))"`
Expected: both print a path inside `node_modules`.

- [ ] **Step 5: Commit**

```bash
git add apps/expo/package.json pnpm-lock.yaml
git commit -m "chore(expo): add expo-sqlite + react-native-webview"
```

---

## Task 0.2: SQLite singleton + migration runner

**Files:**
- Create: `apps/expo/src/lib/db/migrations.ts`
- Create: `apps/expo/src/lib/db/sqlite.ts`
- Test: `apps/expo/src/test/sqlite.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// apps/expo/src/test/sqlite.test.ts
import { describe, expect, it, vi } from "vitest";

import { runMigrations, MIGRATIONS } from "../lib/db/migrations";

type FakeDb = {
  execAsync: ReturnType<typeof vi.fn>;
  getFirstAsync: ReturnType<typeof vi.fn>;
};

function createFakeDb(initialVersion: number): FakeDb {
  return {
    execAsync: vi.fn().mockResolvedValue(undefined),
    getFirstAsync: vi.fn().mockResolvedValue({ user_version: initialVersion }),
  };
}

describe("runMigrations", () => {
  it("applies migrations from version 0 up to the latest", async () => {
    const db = createFakeDb(0);
    await runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
    // Every migration's `up` SQL should have been executed.
    expect(db.execAsync).toHaveBeenCalledWith(MIGRATIONS[0].up);
    expect(db.execAsync).toHaveBeenCalledWith(
      `PRAGMA user_version = ${MIGRATIONS.length};`,
    );
  });

  it("skips migrations already applied", async () => {
    const db = createFakeDb(MIGRATIONS.length);
    await runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
    // user_version pragma never updates because nothing was applied
    expect(db.execAsync).not.toHaveBeenCalledWith(
      expect.stringContaining("PRAGMA user_version ="),
    );
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `pnpm --filter @teamclaw/expo test src/test/sqlite.test.ts`
Expected: FAIL with "Cannot find module '../lib/db/migrations'".

- [ ] **Step 3: Implement migrations module**

```ts
// apps/expo/src/lib/db/migrations.ts
export type MigratorDb = {
  execAsync: (sql: string) => Promise<unknown>;
  getFirstAsync: <T>(sql: string) => Promise<T | null>;
};

export type Migration = {
  version: number;
  up: string;
};

/**
 * Migrations are append-only and applied in order. `user_version` is bumped
 * to `MIGRATIONS.length` after the last one succeeds.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS outbox (
        message_id          TEXT PRIMARY KEY,
        session_id          TEXT NOT NULL,
        team_id             TEXT NOT NULL,
        sender_actor_id     TEXT NOT NULL,
        content             TEXT NOT NULL,
        mention_actor_ids   TEXT NOT NULL DEFAULT '[]',
        reply_to_message_id TEXT,
        attachments         TEXT NOT NULL DEFAULT '[]',
        state               TEXT NOT NULL,
        attempt_count       INTEGER NOT NULL DEFAULT 0,
        last_error          TEXT,
        last_attempt_at     INTEGER,
        next_attempt_at     INTEGER,
        created_at          INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_due ON outbox(state, next_attempt_at);

      CREATE TABLE IF NOT EXISTS connected_agents (
        team_id          TEXT NOT NULL,
        agent_id         TEXT NOT NULL,
        display_name     TEXT NOT NULL,
        agent_kind       TEXT NOT NULL,
        permission_level TEXT NOT NULL,
        visibility       TEXT NOT NULL,
        is_owner         INTEGER NOT NULL,
        device_id        TEXT,
        last_active_at   INTEGER,
        current_model    TEXT,
        status           INTEGER,
        updated_at       INTEGER NOT NULL,
        PRIMARY KEY (team_id, agent_id)
      );
    `,
  },
];

export async function runMigrations(db: MigratorDb): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>(
    "PRAGMA user_version;",
  );
  const current = row?.user_version ?? 0;
  let applied = current;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    await db.execAsync(migration.up);
    applied = migration.version;
  }
  if (applied !== current) {
    await db.execAsync(`PRAGMA user_version = ${applied};`);
  }
}
```

- [ ] **Step 4: Implement sqlite singleton**

```ts
// apps/expo/src/lib/db/sqlite.ts
import * as SQLite from "expo-sqlite";

import { runMigrations } from "./migrations";

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync("teamclaw.db");
      await db.execAsync("PRAGMA journal_mode = WAL;");
      await runMigrations(db);
      return db;
    })();
  }
  return dbPromise;
}

/** Test-only: reset the cached promise so each test opens fresh. */
export function __resetDbForTests(): void {
  dbPromise = null;
}
```

- [ ] **Step 5: Run tests — expect pass**

Run: `pnpm --filter @teamclaw/expo test src/test/sqlite.test.ts`
Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/expo/src/lib/db/ apps/expo/src/test/sqlite.test.ts
git commit -m "feat(expo): add expo-sqlite singleton + migration runner"
```

---

## Task 0.3: MQTT topic matcher

**Files:**
- Create: `apps/expo/src/lib/mqtt/topic-match.ts`
- Test: `apps/expo/src/test/topic-match.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// apps/expo/src/test/topic-match.test.ts
import { describe, expect, it } from "vitest";
import { topicMatches, extractWildcards } from "../lib/mqtt/topic-match";

describe("topicMatches", () => {
  it("matches exact topics", () => {
    expect(topicMatches("amux/t/session/s/live", "amux/t/session/s/live")).toBe(true);
  });
  it("matches single-level wildcard", () => {
    expect(topicMatches("amux/t/device/d/runtime/+/state",
                        "amux/t/device/d/runtime/r1/state")).toBe(true);
  });
  it("rejects when segment count differs", () => {
    expect(topicMatches("amux/t/device/+/runtime/+",
                        "amux/t/device/d/runtime/r/state")).toBe(false);
  });
  it("matches multi-level wildcard", () => {
    expect(topicMatches("amux/t/#", "amux/t/device/d/runtime/r/state")).toBe(true);
  });
  it("multi-level wildcard requires at least one segment", () => {
    expect(topicMatches("amux/t/#", "amux/t")).toBe(false);
  });
});

describe("extractWildcards", () => {
  it("extracts segment values matched by + wildcards in order", () => {
    expect(
      extractWildcards(
        "amux/+/device/+/runtime/+/state",
        "amux/teamA/device/devB/runtime/rtC/state",
      ),
    ).toEqual(["teamA", "devB", "rtC"]);
  });
  it("returns null when topic does not match", () => {
    expect(
      extractWildcards("amux/+/x", "amux/a/b/c"),
    ).toBe(null);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `pnpm --filter @teamclaw/expo test src/test/topic-match.test.ts`
Expected: FAIL "Cannot find module '../lib/mqtt/topic-match'".

- [ ] **Step 3: Implement matcher**

```ts
// apps/expo/src/lib/mqtt/topic-match.ts
export function topicMatches(filter: string, topic: string): boolean {
  const fp = filter.split("/");
  const tp = topic.split("/");
  for (let i = 0; i < fp.length; i++) {
    const f = fp[i];
    if (f === "#") {
      return tp.length > i; // at least one segment must remain
    }
    if (i >= tp.length) return false;
    if (f === "+") continue;
    if (f !== tp[i]) return false;
  }
  return fp.length === tp.length;
}

/** Returns the segment values matched by `+` wildcards, in order, or null. */
export function extractWildcards(filter: string, topic: string): string[] | null {
  if (!topicMatches(filter, topic)) return null;
  const fp = filter.split("/");
  const tp = topic.split("/");
  const out: string[] = [];
  for (let i = 0; i < fp.length; i++) {
    if (fp[i] === "+") out.push(tp[i] ?? "");
  }
  return out;
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `pnpm --filter @teamclaw/expo test src/test/topic-match.test.ts`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/expo/src/lib/mqtt/topic-match.ts apps/expo/src/test/topic-match.test.ts
git commit -m "feat(expo): add MQTT topic-match helper for wildcard fanout"
```

---

## Task 0.4: Team-scoped MQTT client

**Files:**
- Create: `apps/expo/src/lib/mqtt/team-mqtt.ts`
- Test: `apps/expo/src/test/team-mqtt.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// apps/expo/src/test/team-mqtt.test.ts
import { describe, expect, it, vi } from "vitest";
import type { ExpoMqttAdapter, ExpoMqttMessage } from "../lib/mqtt/expo-mqtt";
import { createTeamMqttClient } from "../lib/mqtt/team-mqtt";

function createFakeAdapter(): ExpoMqttAdapter & {
  emitMessage: (m: ExpoMqttMessage) => void;
} {
  let messageHandler: ((m: ExpoMqttMessage) => void) | null = null;
  return {
    async connect() {},
    async disconnect() {},
    async subscribe() {},
    async publish() {},
    onConnectionState: () => () => {},
    onMessage: (handler) => {
      messageHandler = handler;
      return () => {
        messageHandler = null;
      };
    },
    emitMessage(message) {
      messageHandler?.(message);
    },
  };
}

describe("TeamMqttClient", () => {
  it("fans out a message to all handlers whose filter matches the topic", async () => {
    const adapter = createFakeAdapter();
    const client = createTeamMqttClient({
      adapter,
      url: "mqtt://x",
      username: "actor",
      password: "tok",
      clientId: "client",
    });
    await client.start();

    const aHandler = vi.fn();
    const bHandler = vi.fn();
    client.subscribe("amux/t/device/+/runtime/+/state", aHandler);
    client.subscribe("amux/t/session/s/live", bHandler);

    const payload = new Uint8Array([1, 2, 3]);
    adapter.emitMessage({ topic: "amux/t/device/d/runtime/r/state", payload });

    expect(aHandler).toHaveBeenCalledWith(payload, "amux/t/device/d/runtime/r/state");
    expect(bHandler).not.toHaveBeenCalled();
  });

  it("returns an unsubscribe that stops further deliveries", async () => {
    const adapter = createFakeAdapter();
    const client = createTeamMqttClient({
      adapter, url: "mqtt://x", username: "u", password: "p", clientId: "c",
    });
    await client.start();

    const handler = vi.fn();
    const unsubscribe = client.subscribe("amux/t/x", handler);
    unsubscribe();

    adapter.emitMessage({ topic: "amux/t/x", payload: new Uint8Array() });
    expect(handler).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `pnpm --filter @teamclaw/expo test src/test/team-mqtt.test.ts`
Expected: FAIL "Cannot find module '../lib/mqtt/team-mqtt'".

- [ ] **Step 3: Implement team-mqtt**

```ts
// apps/expo/src/lib/mqtt/team-mqtt.ts
import { createExpoMqttAdapter, type ExpoMqttAdapter } from "./expo-mqtt";
import { topicMatches } from "./topic-match";

export type ConnectionState = "connecting" | "connected" | "disconnected";

export type TopicHandler = (payload: Uint8Array, topic: string) => void;

export type TeamMqttClient = {
  start: () => Promise<void>;
  subscribe: (filter: string, handler: TopicHandler) => () => void;
  publish: (topic: string, payload: Uint8Array, retain?: boolean) => Promise<void>;
  onConnectionState: (listener: (state: ConnectionState) => void) => () => void;
  dispose: () => Promise<void>;
};

type Deps = {
  adapter?: ExpoMqttAdapter;
  url: string;
  username: string;
  password: string;
  clientId: string;
};

export function createTeamMqttClient(deps: Deps): TeamMqttClient {
  const adapter = deps.adapter ?? createExpoMqttAdapter();
  const handlers = new Map<string, Set<TopicHandler>>();
  const brokerSubscriptions = new Set<string>();
  let messageUnsubscribe: (() => void) | null = null;

  function dispatch(message: { topic: string; payload: Uint8Array }) {
    for (const [filter, set] of handlers) {
      if (topicMatches(filter, message.topic)) {
        for (const handler of set) {
          handler(message.payload, message.topic);
        }
      }
    }
  }

  return {
    async start() {
      messageUnsubscribe = adapter.onMessage(dispatch);
      await adapter.connect({
        url: deps.url,
        options: {
          clientId: deps.clientId,
          username: deps.username,
          password: deps.password,
          clean: true,
          reconnectPeriod: 0,
        },
      });
    },
    subscribe(filter, handler) {
      let set = handlers.get(filter);
      if (!set) {
        set = new Set();
        handlers.set(filter, set);
      }
      set.add(handler);

      if (!brokerSubscriptions.has(filter)) {
        brokerSubscriptions.add(filter);
        void adapter.subscribe(filter).catch(() => {
          // best-effort; surface via connection state if needed
        });
      }

      return () => {
        const current = handlers.get(filter);
        current?.delete(handler);
        if (current && current.size === 0) {
          handlers.delete(filter);
          // Note: we don't unsubscribe from the broker on the last handler
          // removal because the same filter often comes back moments later
          // (route re-entry). Broker subs are torn down on dispose.
        }
      };
    },
    publish(topic, payload, retain = false) {
      return adapter.publish(topic, payload, retain);
    },
    onConnectionState(listener) {
      return adapter.onConnectionState(listener);
    },
    async dispose() {
      messageUnsubscribe?.();
      messageUnsubscribe = null;
      handlers.clear();
      brokerSubscriptions.clear();
      await adapter.disconnect();
    },
  };
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `pnpm --filter @teamclaw/expo test src/test/team-mqtt.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/expo/src/lib/mqtt/team-mqtt.ts apps/expo/src/test/team-mqtt.test.ts
git commit -m "feat(expo): add team-scoped MQTT client with wildcard fanout"
```

---

# Phase A — Durable Outbox

## Task A.1: Outbox backoff function

**Files:**
- Create: `apps/expo/src/features/sessions/outbox-backoff.ts`
- Test: `apps/expo/src/test/outbox-backoff.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// apps/expo/src/test/outbox-backoff.test.ts
import { describe, expect, it } from "vitest";
import { outboxBackoffMs, OUTBOX_MAX_ATTEMPTS } from "../features/sessions/outbox-backoff";

describe("outboxBackoffMs", () => {
  it("returns 500ms for the first failure", () => {
    expect(outboxBackoffMs(1)).toBe(500);
  });
  it("doubles each step up to the cap", () => {
    expect(outboxBackoffMs(2)).toBe(1000);
    expect(outboxBackoffMs(3)).toBe(2000);
    expect(outboxBackoffMs(4)).toBe(4000);
    expect(outboxBackoffMs(5)).toBe(8000);
    expect(outboxBackoffMs(6)).toBe(16000);
    expect(outboxBackoffMs(7)).toBe(30000);
  });
  it("caps at 30s for all later attempts", () => {
    expect(outboxBackoffMs(20)).toBe(30000);
  });
});

describe("OUTBOX_MAX_ATTEMPTS", () => {
  it("matches iOS budget", () => {
    expect(OUTBOX_MAX_ATTEMPTS).toBe(20);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `pnpm --filter @teamclaw/expo test src/test/outbox-backoff.test.ts`
Expected: FAIL "Cannot find module ...".

- [ ] **Step 3: Implement**

```ts
// apps/expo/src/features/sessions/outbox-backoff.ts
export const OUTBOX_MAX_ATTEMPTS = 20;

/**
 * Schedule: 500ms, 1s, 2s, 4s, 8s, 16s, then 30s capped.
 * `attempt` is the post-bump counter — pass 1 for the first failure.
 * Mirrors iOS OutboxSender.backoff.
 */
export function outboxBackoffMs(attempt: number): number {
  const exp = Math.max(0, attempt - 1);
  const base = Math.pow(2, Math.min(exp, 6)) * 500;
  return Math.min(base, 30_000);
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `pnpm --filter @teamclaw/expo test src/test/outbox-backoff.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/expo/src/features/sessions/outbox-backoff.ts apps/expo/src/test/outbox-backoff.test.ts
git commit -m "feat(expo): outbox backoff curve (mirrors iOS schedule)"
```

---

## Task A.2: Outbox DAO

**Files:**
- Create: `apps/expo/src/features/sessions/outbox-db.ts`
- Test: `apps/expo/src/test/outbox-db.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// apps/expo/src/test/outbox-db.test.ts
import { beforeEach, describe, expect, it } from "vitest";

import { createOutboxDao, type OutboxDao } from "../features/sessions/outbox-db";

type Row = Record<string, unknown>;

function createInMemoryDb() {
  const rows: Row[] = [];
  return {
    rows,
    async runAsync(sql: string, ...params: unknown[]): Promise<void> {
      if (/^INSERT OR IGNORE INTO outbox/i.test(sql)) {
        const [
          message_id, session_id, team_id, sender_actor_id, content,
          mention_actor_ids, reply_to_message_id, attachments,
          state, attempt_count, last_error, last_attempt_at, next_attempt_at,
          created_at,
        ] = params;
        if (rows.some((r) => r.message_id === message_id)) return;
        rows.push({
          message_id, session_id, team_id, sender_actor_id, content,
          mention_actor_ids, reply_to_message_id, attachments,
          state, attempt_count, last_error, last_attempt_at, next_attempt_at,
          created_at,
        });
        return;
      }
      if (/^UPDATE outbox SET state = \?, last_attempt_at = \?/i.test(sql)) {
        const [state, lastAttemptAt, messageId] = params;
        const row = rows.find((r) => r.message_id === messageId);
        if (row) {
          row.state = state;
          row.last_attempt_at = lastAttemptAt;
        }
        return;
      }
      if (/^UPDATE outbox SET state = 'delivered'/i.test(sql)) {
        const [messageId] = params;
        const row = rows.find((r) => r.message_id === messageId);
        if (row) row.state = "delivered";
        return;
      }
      if (/^UPDATE outbox SET state = 'pending', attempt_count = \?, next_attempt_at = \?, last_error = \?/i.test(sql)) {
        const [attempts, next, err, messageId] = params;
        const row = rows.find((r) => r.message_id === messageId);
        if (row) {
          row.state = "pending";
          row.attempt_count = attempts;
          row.next_attempt_at = next;
          row.last_error = err;
        }
        return;
      }
      if (/^UPDATE outbox SET state = 'failed'/i.test(sql)) {
        const [err, messageId] = params;
        const row = rows.find((r) => r.message_id === messageId);
        if (row) {
          row.state = "failed";
          row.last_error = err;
          row.next_attempt_at = null;
        }
        return;
      }
      if (/^UPDATE outbox SET state = 'pending', attempt_count = 0/i.test(sql)) {
        const [messageId] = params;
        const row = rows.find((r) => r.message_id === messageId);
        if (row) {
          row.state = "pending";
          row.attempt_count = 0;
          row.next_attempt_at = null;
          row.last_error = null;
        }
        return;
      }
      throw new Error("unhandled sql: " + sql);
    },
    async getAllAsync(sql: string, ...params: unknown[]): Promise<Row[]> {
      if (/SELECT \* FROM outbox WHERE state = 'pending'/i.test(sql)) {
        const [now] = params as [number];
        return rows.filter(
          (r) => r.state === "pending"
            && (r.next_attempt_at == null || (r.next_attempt_at as number) <= now),
        );
      }
      return [];
    },
    async getFirstAsync(sql: string, ...params: unknown[]): Promise<Row | null> {
      if (/SELECT \* FROM outbox WHERE message_id = \?/i.test(sql)) {
        const [messageId] = params;
        return rows.find((r) => r.message_id === messageId) ?? null;
      }
      return null;
    },
  };
}

describe("OutboxDao", () => {
  let db: ReturnType<typeof createInMemoryDb>;
  let dao: OutboxDao;
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    db = createInMemoryDb();
    dao = createOutboxDao(db as unknown as Parameters<typeof createOutboxDao>[0]);
  });

  it("enqueue is idempotent on messageId", async () => {
    const row = {
      messageId: "m1", sessionId: "s", teamId: "t", senderActorId: "a",
      content: "hi", mentionActorIds: [], replyToMessageId: null,
      attachments: [], createdAt: NOW,
    };
    await dao.enqueue(row);
    await dao.enqueue(row);
    expect(db.rows.length).toBe(1);
  });

  it("fetchDue returns pending rows with null or past nextAttemptAt", async () => {
    await dao.enqueue({
      messageId: "m1", sessionId: "s", teamId: "t", senderActorId: "a",
      content: "hi", mentionActorIds: [], replyToMessageId: null,
      attachments: [], createdAt: NOW,
    });
    const due = await dao.fetchDue(NOW + 1000);
    expect(due.map((r) => r.messageId)).toEqual(["m1"]);
  });

  it("markDelivered transitions row state", async () => {
    await dao.enqueue({
      messageId: "m1", sessionId: "s", teamId: "t", senderActorId: "a",
      content: "hi", mentionActorIds: [], replyToMessageId: null,
      attachments: [], createdAt: NOW,
    });
    await dao.markDelivered("m1");
    const row = await dao.getByMessageId("m1");
    expect(row?.state).toBe("delivered");
  });

  it("retry resets a failed row to pending", async () => {
    await dao.enqueue({
      messageId: "m1", sessionId: "s", teamId: "t", senderActorId: "a",
      content: "hi", mentionActorIds: [], replyToMessageId: null,
      attachments: [], createdAt: NOW,
    });
    await dao.markFailedExhausted("m1", "boom");
    await dao.retry("m1");
    const row = await dao.getByMessageId("m1");
    expect(row?.state).toBe("pending");
    expect(row?.attemptCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `pnpm --filter @teamclaw/expo test src/test/outbox-db.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement DAO**

```ts
// apps/expo/src/features/sessions/outbox-db.ts
import type { MessageAttachment } from "./session-types";

export type OutboxState = "pending" | "inFlight" | "delivered" | "failed";

export type OutboxRow = {
  messageId: string;
  sessionId: string;
  teamId: string;
  senderActorId: string;
  content: string;
  mentionActorIds: string[];
  replyToMessageId: string | null;
  attachments: MessageAttachment[];
  state: OutboxState;
  attemptCount: number;
  lastError: string | null;
  lastAttemptAt: number | null;
  nextAttemptAt: number | null;
  createdAt: number;
};

export type NewOutboxRow = Pick<
  OutboxRow,
  | "messageId" | "sessionId" | "teamId" | "senderActorId"
  | "content" | "mentionActorIds" | "replyToMessageId"
  | "attachments" | "createdAt"
>;

export type OutboxSqliteDb = {
  runAsync: (sql: string, ...params: unknown[]) => Promise<unknown>;
  getAllAsync: (sql: string, ...params: unknown[]) => Promise<Record<string, unknown>[]>;
  getFirstAsync: (sql: string, ...params: unknown[]) => Promise<Record<string, unknown> | null>;
};

export type OutboxDao = {
  enqueue: (row: NewOutboxRow) => Promise<void>;
  fetchDue: (now: number) => Promise<OutboxRow[]>;
  markInFlight: (messageId: string, now: number) => Promise<void>;
  markDelivered: (messageId: string) => Promise<void>;
  markFailedRetry: (messageId: string, attemptCount: number, nextAttemptAt: number, error: string) => Promise<void>;
  markFailedExhausted: (messageId: string, error: string) => Promise<void>;
  retry: (messageId: string) => Promise<void>;
  getByMessageId: (messageId: string) => Promise<OutboxRow | null>;
};

function mapRow(raw: Record<string, unknown>): OutboxRow {
  return {
    messageId: String(raw.message_id),
    sessionId: String(raw.session_id),
    teamId: String(raw.team_id),
    senderActorId: String(raw.sender_actor_id),
    content: String(raw.content),
    mentionActorIds: JSON.parse(String(raw.mention_actor_ids ?? "[]")),
    replyToMessageId: raw.reply_to_message_id ? String(raw.reply_to_message_id) : null,
    attachments: JSON.parse(String(raw.attachments ?? "[]")),
    state: String(raw.state) as OutboxState,
    attemptCount: Number(raw.attempt_count ?? 0),
    lastError: raw.last_error ? String(raw.last_error) : null,
    lastAttemptAt: raw.last_attempt_at == null ? null : Number(raw.last_attempt_at),
    nextAttemptAt: raw.next_attempt_at == null ? null : Number(raw.next_attempt_at),
    createdAt: Number(raw.created_at ?? 0),
  };
}

export function createOutboxDao(db: OutboxSqliteDb): OutboxDao {
  return {
    async enqueue(row) {
      await db.runAsync(
        `INSERT OR IGNORE INTO outbox (
           message_id, session_id, team_id, sender_actor_id, content,
           mention_actor_ids, reply_to_message_id, attachments,
           state, attempt_count, last_error, last_attempt_at, next_attempt_at,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.messageId, row.sessionId, row.teamId, row.senderActorId, row.content,
        JSON.stringify(row.mentionActorIds), row.replyToMessageId,
        JSON.stringify(row.attachments),
        "pending", 0, null, null, null,
        row.createdAt,
      );
    },
    async fetchDue(now) {
      const rows = await db.getAllAsync(
        `SELECT * FROM outbox WHERE state = 'pending'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at ASC`,
        now,
      );
      return rows.map(mapRow);
    },
    async markInFlight(messageId, now) {
      await db.runAsync(
        `UPDATE outbox SET state = ?, last_attempt_at = ? WHERE message_id = ?`,
        "inFlight", now, messageId,
      );
    },
    async markDelivered(messageId) {
      await db.runAsync(
        `UPDATE outbox SET state = 'delivered', last_error = NULL WHERE message_id = ?`,
        messageId,
      );
    },
    async markFailedRetry(messageId, attemptCount, nextAttemptAt, error) {
      await db.runAsync(
        `UPDATE outbox SET state = 'pending', attempt_count = ?, next_attempt_at = ?, last_error = ?
         WHERE message_id = ?`,
        attemptCount, nextAttemptAt, error, messageId,
      );
    },
    async markFailedExhausted(messageId, error) {
      await db.runAsync(
        `UPDATE outbox SET state = 'failed', last_error = ?, next_attempt_at = NULL
         WHERE message_id = ?`,
        error, messageId,
      );
    },
    async retry(messageId) {
      await db.runAsync(
        `UPDATE outbox SET state = 'pending', attempt_count = 0, next_attempt_at = NULL, last_error = NULL
         WHERE message_id = ?`,
        messageId,
      );
    },
    async getByMessageId(messageId) {
      const row = await db.getFirstAsync(
        `SELECT * FROM outbox WHERE message_id = ? LIMIT 1`,
        messageId,
      );
      return row ? mapRow(row) : null;
    },
  };
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `pnpm --filter @teamclaw/expo test src/test/outbox-db.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/expo/src/features/sessions/outbox-db.ts apps/expo/src/test/outbox-db.test.ts
git commit -m "feat(expo): outbox DAO over expo-sqlite"
```

---

## Task A.3: Outbox sender loop

**Files:**
- Create: `apps/expo/src/features/sessions/outbox-sender.ts`
- Test: `apps/expo/src/test/outbox-sender.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// apps/expo/src/test/outbox-sender.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OutboxDao, OutboxRow } from "../features/sessions/outbox-db";
import { createOutboxSender } from "../features/sessions/outbox-sender";

function makeRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    messageId: "m1", sessionId: "s1", teamId: "t1", senderActorId: "a1",
    content: "hi", mentionActorIds: [], replyToMessageId: null,
    attachments: [], state: "pending", attemptCount: 0,
    lastError: null, lastAttemptAt: null, nextAttemptAt: null,
    createdAt: 0, ...overrides,
  };
}

function createFakeDao(): OutboxDao & {
  pending: OutboxRow[];
  delivered: string[];
  failed: { id: string; attempts: number }[];
} {
  const state: OutboxDao & {
    pending: OutboxRow[];
    delivered: string[];
    failed: { id: string; attempts: number }[];
  } = {
    pending: [],
    delivered: [],
    failed: [],
    async enqueue(row) { state.pending.push(makeRow({ ...row, state: "pending" })); },
    async fetchDue() { return state.pending.filter((r) => r.state === "pending"); },
    async markInFlight(id) {
      const row = state.pending.find((r) => r.messageId === id);
      if (row) row.state = "inFlight";
    },
    async markDelivered(id) {
      state.delivered.push(id);
      const row = state.pending.find((r) => r.messageId === id);
      if (row) row.state = "delivered";
    },
    async markFailedRetry(id, attempts, next) {
      const row = state.pending.find((r) => r.messageId === id);
      if (row) { row.state = "pending"; row.attemptCount = attempts; row.nextAttemptAt = next; }
    },
    async markFailedExhausted(id, _err) {
      state.failed.push({ id, attempts: state.pending.find((r) => r.messageId === id)?.attemptCount ?? 0 });
      const row = state.pending.find((r) => r.messageId === id);
      if (row) row.state = "failed";
    },
    async retry(id) {
      const row = state.pending.find((r) => r.messageId === id);
      if (row) { row.state = "pending"; row.attemptCount = 0; row.nextAttemptAt = null; }
    },
    async getByMessageId(id) {
      return state.pending.find((r) => r.messageId === id) ?? null;
    },
  };
  return state;
}

describe("OutboxSender", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("delivers a pending row via the send fn", async () => {
    const dao = createFakeDao();
    await dao.enqueue({
      messageId: "m1", sessionId: "s", teamId: "t", senderActorId: "a",
      content: "hi", mentionActorIds: [], replyToMessageId: null,
      attachments: [], createdAt: 0,
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const sender = createOutboxSender({ dao, send, onChange: () => {} });
    sender.start();
    await vi.advanceTimersByTimeAsync(1500);
    sender.stop();
    expect(send).toHaveBeenCalledTimes(1);
    expect(dao.delivered).toEqual(["m1"]);
  });

  it("schedules a retry with backoff on send failure", async () => {
    const dao = createFakeDao();
    await dao.enqueue({
      messageId: "m1", sessionId: "s", teamId: "t", senderActorId: "a",
      content: "hi", mentionActorIds: [], replyToMessageId: null,
      attachments: [], createdAt: 0,
    });
    const send = vi.fn().mockRejectedValueOnce(new Error("net")).mockResolvedValue(undefined);
    const sender = createOutboxSender({ dao, send, onChange: () => {} });
    sender.start();
    await vi.advanceTimersByTimeAsync(1500); // first attempt → fails, scheduled for +500ms
    expect(dao.pending[0].state).toBe("pending");
    expect(dao.pending[0].attemptCount).toBe(1);
    await vi.advanceTimersByTimeAsync(2000); // second attempt → succeeds
    sender.stop();
    expect(send).toHaveBeenCalledTimes(2);
    expect(dao.delivered).toEqual(["m1"]);
  });

  it("marks failed after exhausting attempts", async () => {
    const dao = createFakeDao();
    await dao.enqueue({
      messageId: "m1", sessionId: "s", teamId: "t", senderActorId: "a",
      content: "hi", mentionActorIds: [], replyToMessageId: null,
      attachments: [], createdAt: 0,
    });
    const send = vi.fn().mockRejectedValue(new Error("net"));
    const sender = createOutboxSender({ dao, send, onChange: () => {} });
    sender.start();
    // 20 attempts each gated by tick+backoff — fast-forward generously
    await vi.advanceTimersByTimeAsync(20 * 31_000);
    sender.stop();
    expect(dao.failed.length).toBe(1);
    expect(dao.failed[0].attempts).toBeGreaterThanOrEqual(20);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `pnpm --filter @teamclaw/expo test src/test/outbox-sender.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement sender**

```ts
// apps/expo/src/features/sessions/outbox-sender.ts
import { OUTBOX_MAX_ATTEMPTS, outboxBackoffMs } from "./outbox-backoff";
import type { NewOutboxRow, OutboxDao, OutboxRow } from "./outbox-db";

export type OutboxSendFn = (row: OutboxRow) => Promise<void>;

export type OutboxSender = {
  start: () => void;
  stop: () => void;
  enqueue: (row: NewOutboxRow) => Promise<void>;
  retry: (messageId: string) => Promise<void>;
};

type Deps = {
  dao: OutboxDao;
  send: OutboxSendFn;
  onChange: () => void;
  tickMs?: number;
  now?: () => number;
};

export function createOutboxSender(deps: Deps): OutboxSender {
  const tickMs = deps.tickMs ?? 1000;
  const now = deps.now ?? (() => Date.now());
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  async function pass() {
    const due = await deps.dao.fetchDue(now());
    for (const row of due) {
      await attempt(row);
    }
  }

  async function attempt(row: OutboxRow) {
    await deps.dao.markInFlight(row.messageId, now());
    deps.onChange();
    try {
      await deps.send(row);
      await deps.dao.markDelivered(row.messageId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const nextAttempt = row.attemptCount + 1;
      if (nextAttempt >= OUTBOX_MAX_ATTEMPTS) {
        await deps.dao.markFailedExhausted(row.messageId, message);
      } else {
        await deps.dao.markFailedRetry(
          row.messageId,
          nextAttempt,
          now() + outboxBackoffMs(nextAttempt),
          message,
        );
      }
    }
    deps.onChange();
  }

  function scheduleNext() {
    if (!running) return;
    timer = setTimeout(async () => {
      try { await pass(); } catch {}
      scheduleNext();
    }, tickMs);
  }

  return {
    start() {
      if (running) return;
      running = true;
      scheduleNext();
    },
    stop() {
      running = false;
      if (timer) { clearTimeout(timer); timer = null; }
    },
    async enqueue(row) {
      await deps.dao.enqueue(row);
      deps.onChange();
    },
    async retry(messageId) {
      await deps.dao.retry(messageId);
      deps.onChange();
    },
  };
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `pnpm --filter @teamclaw/expo test src/test/outbox-sender.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/expo/src/features/sessions/outbox-sender.ts apps/expo/src/test/outbox-sender.test.ts
git commit -m "feat(expo): durable outbox sender with backoff + retry"
```

---

## Task A.4: Rewrite outbox-store to read from DAO

**Files:**
- Modify: `apps/expo/src/features/sessions/outbox-store.ts`

- [ ] **Step 1: Replace file contents**

The new store keeps the same public surface (`setOutboxStatus`, `clearOutboxStatus`, `getOutboxSnapshot`, `subscribeOutbox`, `resetOutbox`) so existing consumers (`SessionMessageRow.tsx`) compile unchanged. Internally it is just an in-process Map plus a `refreshFromDao` helper the sender can call.

```ts
// apps/expo/src/features/sessions/outbox-store.ts
import type { OutboxDao, OutboxState } from "./outbox-db";

export type OutboxStatus = "sending" | "sent" | "failed";

type Listener = (snapshot: ReadonlyMap<string, OutboxStatus>) => void;

const state = new Map<string, OutboxStatus>();
const listeners = new Set<Listener>();

function emit() {
  const snapshot = new Map(state);
  for (const listener of listeners) listener(snapshot);
}

function toUiStatus(state: OutboxState): OutboxStatus | null {
  switch (state) {
    case "pending":
    case "inFlight":
      return "sending";
    case "delivered":
      return "sent";
    case "failed":
      return "failed";
  }
}

export function setOutboxStatus(messageId: string, status: OutboxStatus): void {
  if (!messageId) return;
  state.set(messageId, status);
  emit();
}

export function clearOutboxStatus(messageId: string): void {
  if (!messageId) return;
  if (!state.has(messageId)) return;
  state.delete(messageId);
  emit();
}

export function getOutboxSnapshot(): ReadonlyMap<string, OutboxStatus> {
  return new Map(state);
}

export function subscribeOutbox(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Pulls current DAO state for the given message ids and reconciles the
 * in-memory map. The sender calls this after every transition so the UI
 * dot reflects durable state, not just optimistic guesses.
 */
export async function syncOutboxFromDao(
  dao: OutboxDao,
  messageIds: string[],
): Promise<void> {
  let changed = false;
  for (const id of messageIds) {
    const row = await dao.getByMessageId(id);
    if (!row) {
      if (state.delete(id)) changed = true;
      continue;
    }
    const next = toUiStatus(row.state);
    if (next == null) continue;
    if (state.get(id) !== next) {
      state.set(id, next);
      changed = true;
    }
  }
  if (changed) emit();
}

export function resetOutbox(): void {
  state.clear();
  emit();
}
```

- [ ] **Step 2: Update existing outbox-store usages still type-check**

Run: `pnpm --filter @teamclaw/expo exec tsc --noEmit`
Expected: PASS. No callers were removed; the export surface is a superset.

- [ ] **Step 3: Commit**

```bash
git add apps/expo/src/features/sessions/outbox-store.ts
git commit -m "feat(expo): outbox-store reconciles from DAO after each transition"
```

---

## Task A.5: Wire sender into session-detail-controller

**Files:**
- Modify: `apps/expo/src/features/sessions/session-detail-controller.ts`

- [ ] **Step 1: Add sender dep + lifecycle hooks**

Open `apps/expo/src/features/sessions/session-detail-controller.ts`. Add to the imports:

```ts
import type { OutboxSender } from "./outbox-sender";
import { syncOutboxFromDao } from "./outbox-store";
import type { OutboxDao } from "./outbox-db";
```

Add to `SessionDetailControllerDeps`:

```ts
  outbox?: { sender: OutboxSender; dao: OutboxDao };
```

Inside `createSessionDetailController`, after the controller object is built, when `deps.outbox` is present, start it in `load()` and stop it in `dispose()`.

- [ ] **Step 2: Replace inline publish in `sendMessage` with enqueue**

Locate the `sendMessage` block. The current path inserts an optimistic message, calls `deps.api.insertOutgoingMessage`, then `deps.mqtt.publish`. Replace the publish-call with sender enqueue:

```ts
        if (deps.outbox) {
          await deps.outbox.sender.enqueue({
            messageId,
            sessionId: deps.sessionId,
            teamId: deps.teamId,
            senderActorId: actorId,
            content,
            mentionActorIds: [],
            replyToMessageId: replyTo,
            attachments: pendingAttachments.map((row) => ({
              url: row.publicUrl || row.path,
              path: row.path,
              mime: row.mime,
              size: row.size,
            })),
            createdAt: Date.parse(createdAt),
          });
          await syncOutboxFromDao(deps.outbox.dao, [messageId]);
        } else {
          // Fallback path (unit tests without sender): keep current inline publish.
          // [existing publish block stays here]
        }
```

The branch above keeps the existing inline publish path so test files that don't pass `outbox` still work.

- [ ] **Step 3: Type-check**

Run: `pnpm --filter @teamclaw/expo exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Run existing session-detail-controller tests**

Run: `pnpm --filter @teamclaw/expo test src/test/session-detail-controller.test.ts`
Expected: pre-existing tests still pass (no `outbox` dep wired in tests).

- [ ] **Step 5: Commit**

```bash
git add apps/expo/src/features/sessions/session-detail-controller.ts
git commit -m "feat(expo): controller delegates send to durable outbox when wired"
```

---

## Task A.6: Build outbox at the route layer + retry on failed dot

**Files:**
- Modify: `apps/expo/app/(app)/(tabs)/sessions/[sessionId].tsx`
- Modify: `apps/expo/src/features/sessions/components/SessionMessageRow.tsx`

- [ ] **Step 1: Construct DAO + sender in the route**

Open `apps/expo/app/(app)/(tabs)/sessions/[sessionId].tsx`. Near where the controller is built, before passing deps, wire the outbox:

```ts
import { getDb } from "../../../../src/lib/db/sqlite";
import { createOutboxDao } from "../../../../src/features/sessions/outbox-db";
import { createOutboxSender } from "../../../../src/features/sessions/outbox-sender";
import { syncOutboxFromDao } from "../../../../src/features/sessions/outbox-store";

// inside route component, before controller construction:
const outboxRef = useRef<{ sender: ReturnType<typeof createOutboxSender>; dao: ReturnType<typeof createOutboxDao> } | null>(null);
useEffect(() => {
  let disposed = false;
  void (async () => {
    const db = await getDb();
    if (disposed) return;
    const dao = createOutboxDao(db);
    const sender = createOutboxSender({
      dao,
      send: async (row) => {
        // protobuf+publish path identical to controller's prior inline publish
        // — extracted into a closure here so the sender owns the network call.
        await sendOutboxRowViaMqtt(row, /* deps captured from controller */);
      },
      onChange: () => {
        void syncOutboxFromDao(dao, [/* current in-flight ids */]);
      },
    });
    outboxRef.current = { dao, sender };
  })();
  return () => { disposed = true; outboxRef.current?.sender.stop(); };
}, []);
```

The `sendOutboxRowViaMqtt` helper is added next.

- [ ] **Step 2: Extract the existing MQTT publish into a reusable send fn**

Create a small helper inside the route file (or extract to `session-detail-controller.ts` if cleaner) named `sendOutboxRowViaMqtt(row, { mqtt, teamId, sessionId, ... })`. Move the proto encoding + `deps.mqtt.publish` call previously living in `sendMessage` into this helper. The sender now invokes it; the controller's `sendMessage` only calls `sender.enqueue(...)` and inserts the optimistic UI row.

- [ ] **Step 3: Wire failed-dot tap to retry**

In `SessionMessageRow.tsx`, the bubble already reflects `OutboxStatus`. Add an `onRetryFailed?: () => void` prop. When `status === "failed"` and the dot is tapped, fire `onRetryFailed?.()`. In the screen layer, plumb the prop down to call `outboxRef.current?.sender.retry(messageId)`.

- [ ] **Step 4: Type-check**

Run: `pnpm --filter @teamclaw/expo exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/expo/app/\(app\)/\(tabs\)/sessions/\[sessionId\].tsx \
        apps/expo/src/features/sessions/components/SessionMessageRow.tsx
git commit -m "feat(expo): wire durable outbox + failed-dot retry into session detail"
```

---

# Phase B — Timeline Reducer

## Task B.1: TimelineEvent / TimelineState types

**Files:**
- Modify: `apps/expo/src/features/sessions/session-types.ts`
- Create: `apps/expo/src/features/sessions/timeline-reducer.ts`

- [ ] **Step 1: Add type exports to `session-types.ts`**

Append to `session-types.ts`:

```ts
export type StreamingBuffer = {
  messageId: string;
  text: string;
  kind: string;
  startedAt: string;
  senderActorId: string;
};

export type TimelineEvent =
  | { kind: "messageCommitted"; message: SessionMessage }
  | { kind: "streamingDelta";
      agentId: string; messageId: string; messageKind: string;
      deltaText: string; createdAt: string; }
  | { kind: "streamingDone"; agentId: string; messageId: string };
```

- [ ] **Step 2: Create reducer scaffold (no body yet)**

```ts
// apps/expo/src/features/sessions/timeline-reducer.ts
import type {
  SessionMessage,
  StreamingBuffer,
  TimelineEvent,
} from "./session-types";

export type TimelineState = {
  messages: SessionMessage[];
  streamingByAgent: Map<string, StreamingBuffer>;
};

export function emptyTimelineState(): TimelineState {
  return { messages: [], streamingByAgent: new Map() };
}

export function reduceTimeline(state: TimelineState, event: TimelineEvent): TimelineState {
  throw new Error("not implemented");
}
```

- [ ] **Step 3: Type-check**

Run: `pnpm --filter @teamclaw/expo exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/expo/src/features/sessions/session-types.ts \
        apps/expo/src/features/sessions/timeline-reducer.ts
git commit -m "feat(expo): timeline reducer types + scaffold"
```

---

## Task B.2: Reducer — messageCommitted

**Files:**
- Modify: `apps/expo/src/features/sessions/timeline-reducer.ts`
- Test: `apps/expo/src/test/timeline-reducer.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// apps/expo/src/test/timeline-reducer.test.ts
import { describe, expect, it } from "vitest";

import { emptyTimelineState, reduceTimeline } from "../features/sessions/timeline-reducer";
import type { SessionMessage } from "../features/sessions/session-types";

function msg(id: string, content: string, createdAt = "2026-05-20T10:00:00.000Z"): SessionMessage {
  return {
    content, createdAt, kind: "text", messageId: id, metadata: null,
    model: "", replyToMessageId: "", senderActorId: "agent-1",
    sessionId: "s", teamId: "t", turnId: "",
  };
}

describe("reduceTimeline · messageCommitted", () => {
  it("inserts a new message sorted by createdAt", () => {
    let s = emptyTimelineState();
    s = reduceTimeline(s, { kind: "messageCommitted", message: msg("a", "first", "2026-05-20T10:00:00.000Z") });
    s = reduceTimeline(s, { kind: "messageCommitted", message: msg("b", "second", "2026-05-20T10:01:00.000Z") });
    expect(s.messages.map((m) => m.messageId)).toEqual(["a", "b"]);
  });

  it("replaces existing row when content is longer (streaming converges)", () => {
    let s = emptyTimelineState();
    s = reduceTimeline(s, { kind: "messageCommitted", message: msg("a", "Hel") });
    s = reduceTimeline(s, { kind: "messageCommitted", message: msg("a", "Hello world") });
    expect(s.messages[0].content).toBe("Hello world");
  });

  it("ignores recommit with shorter or equal content", () => {
    let s = emptyTimelineState();
    s = reduceTimeline(s, { kind: "messageCommitted", message: msg("a", "Hello world") });
    s = reduceTimeline(s, { kind: "messageCommitted", message: msg("a", "Hello") });
    expect(s.messages[0].content).toBe("Hello world");
  });

  it("clears streamingByAgent entry that committed", () => {
    let s = emptyTimelineState();
    s = reduceTimeline(s, {
      kind: "streamingDelta", agentId: "agent-1", messageId: "a",
      messageKind: "agent_reply", deltaText: "Hel", createdAt: "2026-05-20T10:00:00.000Z",
    });
    s = reduceTimeline(s, { kind: "messageCommitted", message: msg("a", "Hello") });
    expect(s.streamingByAgent.has("agent-1")).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @teamclaw/expo test src/test/timeline-reducer.test.ts`
Expected: FAIL with "not implemented".

- [ ] **Step 3: Implement messageCommitted branch**

Replace the reducer body in `timeline-reducer.ts`:

```ts
function timeValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function insertSorted(messages: SessionMessage[], next: SessionMessage): SessionMessage[] {
  const idx = messages.findIndex((m) => m.messageId === next.messageId);
  if (idx >= 0) {
    if (next.content.length > messages[idx].content.length) {
      const out = messages.slice();
      out[idx] = next;
      return out;
    }
    return messages;
  }
  const out = [...messages, next];
  out.sort((a, b) => {
    const dt = timeValue(a.createdAt) - timeValue(b.createdAt);
    if (dt !== 0) return dt;
    return a.messageId.localeCompare(b.messageId);
  });
  return out;
}

function clearStreamingByMessageId(
  streamingByAgent: Map<string, StreamingBuffer>,
  messageId: string,
): Map<string, StreamingBuffer> {
  let changed = false;
  const next = new Map(streamingByAgent);
  for (const [agentId, buf] of next) {
    if (buf.messageId === messageId) {
      next.delete(agentId);
      changed = true;
    }
  }
  return changed ? next : streamingByAgent;
}

export function reduceTimeline(state: TimelineState, event: TimelineEvent): TimelineState {
  switch (event.kind) {
    case "messageCommitted": {
      const messages = insertSorted(state.messages, event.message);
      const streamingByAgent = clearStreamingByMessageId(
        state.streamingByAgent,
        event.message.messageId,
      );
      if (messages === state.messages && streamingByAgent === state.streamingByAgent) {
        return state;
      }
      return { messages, streamingByAgent };
    }
    case "streamingDelta":
    case "streamingDone":
      return state;
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `pnpm --filter @teamclaw/expo test src/test/timeline-reducer.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/expo/src/features/sessions/timeline-reducer.ts apps/expo/src/test/timeline-reducer.test.ts
git commit -m "feat(expo): reducer handles messageCommitted with longest-content-wins"
```

---

## Task B.3: Reducer — streamingDelta + streamingDone

**Files:**
- Modify: `apps/expo/src/features/sessions/timeline-reducer.ts`
- Modify: `apps/expo/src/test/timeline-reducer.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
describe("reduceTimeline · streamingDelta", () => {
  it("appends delta into a buffer keyed by agentId", () => {
    let s = emptyTimelineState();
    s = reduceTimeline(s, { kind: "streamingDelta", agentId: "a", messageId: "m1",
      messageKind: "agent_reply", deltaText: "Hel", createdAt: "2026-05-20T10:00:00.000Z" });
    s = reduceTimeline(s, { kind: "streamingDelta", agentId: "a", messageId: "m1",
      messageKind: "agent_reply", deltaText: "lo", createdAt: "2026-05-20T10:00:00.500Z" });
    expect(s.streamingByAgent.get("a")?.text).toBe("Hello");
  });

  it("two agents stream independently", () => {
    let s = emptyTimelineState();
    s = reduceTimeline(s, { kind: "streamingDelta", agentId: "a", messageId: "m1",
      messageKind: "agent_reply", deltaText: "Hi", createdAt: "2026-05-20T10:00:00.000Z" });
    s = reduceTimeline(s, { kind: "streamingDelta", agentId: "b", messageId: "m2",
      messageKind: "agent_reply", deltaText: "Sup", createdAt: "2026-05-20T10:00:00.000Z" });
    expect(s.streamingByAgent.get("a")?.text).toBe("Hi");
    expect(s.streamingByAgent.get("b")?.text).toBe("Sup");
  });

  it("does not modify messages array", () => {
    let s = emptyTimelineState();
    s = reduceTimeline(s, { kind: "streamingDelta", agentId: "a", messageId: "m1",
      messageKind: "agent_reply", deltaText: "Hi", createdAt: "2026-05-20T10:00:00.000Z" });
    expect(s.messages).toEqual([]);
  });
});

describe("reduceTimeline · streamingDone", () => {
  it("clears the agent's buffer", () => {
    let s = emptyTimelineState();
    s = reduceTimeline(s, { kind: "streamingDelta", agentId: "a", messageId: "m1",
      messageKind: "agent_reply", deltaText: "Hi", createdAt: "2026-05-20T10:00:00.000Z" });
    s = reduceTimeline(s, { kind: "streamingDone", agentId: "a", messageId: "m1" });
    expect(s.streamingByAgent.has("a")).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @teamclaw/expo test src/test/timeline-reducer.test.ts`
Expected: new tests fail.

- [ ] **Step 3: Implement branches**

In `timeline-reducer.ts`, replace the `streamingDelta` / `streamingDone` cases:

```ts
    case "streamingDelta": {
      const prev = state.streamingByAgent.get(event.agentId);
      const next: StreamingBuffer = prev && prev.messageId === event.messageId
        ? { ...prev, text: prev.text + event.deltaText }
        : {
            agentId: event.agentId,
            messageId: event.messageId,
            text: event.deltaText,
            kind: event.messageKind,
            startedAt: event.createdAt,
            senderActorId: event.agentId,
          } as unknown as StreamingBuffer;
      const streamingByAgent = new Map(state.streamingByAgent);
      streamingByAgent.set(event.agentId, next);
      return { ...state, streamingByAgent };
    }
    case "streamingDone": {
      if (!state.streamingByAgent.has(event.agentId)) return state;
      const streamingByAgent = new Map(state.streamingByAgent);
      streamingByAgent.delete(event.agentId);
      return { ...state, streamingByAgent };
    }
```

- [ ] **Step 4: Run — expect pass**

Run: `pnpm --filter @teamclaw/expo test src/test/timeline-reducer.test.ts`
Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/expo/src/features/sessions/timeline-reducer.ts apps/expo/src/test/timeline-reducer.test.ts
git commit -m "feat(expo): reducer handles streamingDelta + streamingDone"
```

---

## Task B.4: Integrate reducer into session-detail-controller

**Files:**
- Modify: `apps/expo/src/features/sessions/session-detail-controller.ts`

- [ ] **Step 1: Replace `mergeMessage` with reducer**

Remove the `mergeMessage` function and add:

```ts
import { reduceTimeline, emptyTimelineState, type TimelineState } from "./timeline-reducer";
import type { TimelineEvent } from "./session-types";
```

Add `streamingByAgent` to the controller state:

```ts
export type SessionDetailControllerState = {
  // … existing fields
  streamingByAgent: ReadonlyMap<string, StreamingBuffer>;
};
```

Track a `TimelineState` alongside the user-facing state. After each MQTT message decode and after the initial `listMessages` fetch:

```ts
const event: TimelineEvent = { kind: "messageCommitted", message: nextMessage };
const nextTimeline = reduceTimeline(timeline, event);
timeline = nextTimeline;
setState({
  ...state,
  messages: nextTimeline.messages,
  streamingByAgent: nextTimeline.streamingByAgent,
  status: nextStatusForMessages(state.session, nextTimeline.messages, state.status),
});
```

The bulk `listMessages` response runs the same reducer in a `for` loop over the returned rows.

- [ ] **Step 2: Type-check**

Run: `pnpm --filter @teamclaw/expo exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Verify session-detail-controller tests still pass**

Run: `pnpm --filter @teamclaw/expo test src/test/session-detail-controller.test.ts`
Expected: all existing tests pass (semantics unchanged for full-message MQTT events).

- [ ] **Step 4: Commit**

```bash
git add apps/expo/src/features/sessions/session-detail-controller.ts
git commit -m "feat(expo): replace mergeMessage with timeline reducer"
```

---

## Task B.5: Render streaming virtual rows in SessionDetailScreen

**Files:**
- Modify: `apps/expo/src/features/sessions/screens/SessionDetailScreen.tsx`
- Modify: `apps/expo/src/features/sessions/components/SessionMessageRow.tsx`

- [ ] **Step 1: Add `isStreaming` prop + blinking cursor to `SessionMessageRow`**

Add:

```ts
type Props = {
  // … existing
  isStreaming?: boolean;
};
```

When `isStreaming` is true, append a `▌` character to the rendered body wrapped in an `Animated.Text` that loops opacity 0 → 1 every 600ms.

- [ ] **Step 2: Build virtual rows in `SessionDetailScreen`**

Where `messages` is rendered, derive the final row list:

```ts
const streamingRows: SessionMessage[] = Array.from(state.streamingByAgent.values()).map((buf) => ({
  messageId: buf.messageId,
  sessionId: state.session?.sessionId ?? "",
  teamId: state.session?.teamId ?? "",
  senderActorId: buf.senderActorId,
  content: buf.text,
  kind: buf.kind,
  createdAt: buf.startedAt,
  metadata: null,
  model: "",
  replyToMessageId: "",
  turnId: "",
}));
const renderRows = [...state.messages, ...streamingRows];
```

Pass `isStreaming={true}` only for rows whose `messageId` is in the streaming buffer.

- [ ] **Step 3: Manual smoke**

Run: `pnpm --filter @teamclaw/expo dev` (Expo dev server). Open a session detail. Send a message: bubble shows status dot transitions; if daemon emits delta events in future, blinking cursor renders.

- [ ] **Step 4: Commit**

```bash
git add apps/expo/src/features/sessions/screens/SessionDetailScreen.tsx \
        apps/expo/src/features/sessions/components/SessionMessageRow.tsx
git commit -m "feat(expo): render per-agent streaming virtual rows with cursor"
```

---

# Phase C — ShortcutWebView

## Task C.1: Register modal route

**Files:**
- Modify: `apps/expo/app/(app)/_layout.tsx`
- Create: `apps/expo/app/(app)/shortcut-web.tsx`

- [ ] **Step 1: Register the screen in `(app)/_layout.tsx`**

Locate the `<Stack>` block. Add a screen:

```tsx
<Stack.Screen
  name="shortcut-web"
  options={{
    presentation: "fullScreenModal",
    headerShown: false,
    animation: "slide_from_right",
    gestureEnabled: true,
  }}
/>
```

- [ ] **Step 2: Create the route file**

```tsx
// apps/expo/app/(app)/shortcut-web.tsx
import { useLocalSearchParams, useRouter } from "expo-router";

import { ShortcutWebScreen } from "../../src/features/shortcuts/ShortcutWebScreen";

export default function ShortcutWebRoute() {
  const router = useRouter();
  const { url, title } = useLocalSearchParams<{ url?: string; title?: string }>();
  if (!url) {
    return null;
  }
  return (
    <ShortcutWebScreen
      url={url}
      title={title ?? ""}
      onClose={() => {
        if (router.canGoBack()) router.back();
        else router.replace("/(app)/(tabs)/sessions");
      }}
    />
  );
}
```

- [ ] **Step 3: Type-check**

Run: `pnpm --filter @teamclaw/expo exec tsc --noEmit`
Expected: PASS (ShortcutWebScreen comes next; either stub-import or skip this step until C.2).

If tsc fails because `ShortcutWebScreen` doesn't exist yet, do Task C.2 next and re-run.

---

## Task C.2: ShortcutWebScreen — chrome + WebView

**Files:**
- Create: `apps/expo/src/features/shortcuts/ShortcutWebScreen.tsx`

- [ ] **Step 1: Implement screen**

```tsx
// apps/expo/src/features/shortcuts/ShortcutWebScreen.tsx
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewNavigation } from "react-native-webview";

import { colors, spacing, typography } from "../../ui/theme";

export type ShortcutWebScreenProps = {
  url: string;
  title: string;
  onClose: () => void;
};

export function ShortcutWebScreen({ url, title, onClose }: ShortcutWebScreenProps) {
  const webviewRef = useRef<WebView>(null);
  const insets = useSafeAreaInsets();
  const [nav, setNav] = useState<WebViewNavigation>({
    canGoBack: false,
    canGoForward: false,
    loading: true,
    title: "",
    url,
    navigationType: "other",
    lockIdentifier: 0,
    target: "",
  } as WebViewNavigation);

  const phase = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!nav.loading) {
      phase.stopAnimation();
      phase.setValue(0);
      return;
    }
    Animated.loop(
      Animated.timing(phase, {
        toValue: 1,
        duration: 1100,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    ).start();
  }, [nav.loading, phase]);

  const host = (() => {
    try { return new URL(nav.url).host; } catch { return ""; }
  })();

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.chrome}>
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          hitSlop={8}
          onPress={onClose}
          style={styles.closeButton}
        >
          <Ionicons color={colors.basalt} name="close" size={14} />
        </Pressable>

        <View style={styles.titleColumn}>
          <Text numberOfLines={1} style={styles.title}>
            {nav.title || title}
          </Text>
          <Text numberOfLines={1} style={styles.host}>
            {host || nav.url}
          </Text>
        </View>

        <ChromeButton enabled={nav.canGoBack} icon="chevron-back" onPress={() => webviewRef.current?.goBack()} />
        <ChromeButton enabled={nav.canGoForward} icon="chevron-forward" onPress={() => webviewRef.current?.goForward()} />
        <ChromeButton enabled icon="refresh" onPress={() => webviewRef.current?.reload()} />
        <ChromeButton
          enabled
          icon="share-outline"
          onPress={() => { void Share.share({ url: nav.url, message: nav.title || nav.url }); }}
        />
      </View>

      <View style={styles.loadingBarContainer}>
        {nav.loading ? (
          <Animated.View
            style={[
              styles.loadingBar,
              {
                transform: [{
                  translateX: phase.interpolate({ inputRange: [0, 1], outputRange: [-80, 360] }),
                }],
              },
            ]}
          />
        ) : null}
      </View>

      <WebView
        ref={webviewRef}
        source={{ uri: url }}
        onNavigationStateChange={setNav}
        allowsInlineMediaPlayback
        allowsBackForwardNavigationGestures
        mediaPlaybackRequiresUserAction={false}
        originWhitelist={["*"]}
        startInLoadingState
        style={styles.webview}
      />
    </View>
  );
}

function ChromeButton({
  enabled, icon, onPress,
}: { enabled: boolean; icon: React.ComponentProps<typeof Ionicons>["name"]; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={!enabled}
      onPress={onPress}
      style={({ pressed }) => [styles.chromeButton, !enabled ? styles.chromeButtonDisabled : null, pressed ? styles.chromeButtonPressed : null]}
    >
      <Ionicons color={enabled ? colors.basalt : colors.slate} name={icon} size={14} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chrome: {
    alignItems: "center",
    backgroundColor: colors.paper,
    flexDirection: "row",
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  chromeButton: {
    alignItems: "center",
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  chromeButtonDisabled: { opacity: 0.5 },
  chromeButtonPressed: { opacity: 0.6 },
  closeButton: {
    alignItems: "center",
    backgroundColor: colors.pebble,
    borderRadius: 15,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  host: {
    color: colors.slate,
    fontFamily: typography.mono.fontFamily,
    fontSize: 11,
  },
  loadingBar: {
    backgroundColor: colors.cinnabar,
    height: 1.5,
    width: 80,
  },
  loadingBarContainer: {
    backgroundColor: colors.hairline,
    height: 1.5,
    overflow: "hidden",
  },
  screen: { backgroundColor: colors.paper, flex: 1 },
  title: {
    color: colors.onyx,
    fontSize: 14,
    fontWeight: "600",
  },
  titleColumn: { flex: 1, marginLeft: 6 },
  webview: { flex: 1 },
});
```

- [ ] **Step 2: Type-check**

Run: `pnpm --filter @teamclaw/expo exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Manual smoke**

Run dev: `pnpm --filter @teamclaw/expo dev`. From `app/_layout.tsx`'s root, manually navigate `router.push('/(app)/shortcut-web?url=https://example.com&title=Example')`. Verify chrome buttons disable/enable, loading bar animates, close returns.

- [ ] **Step 4: Commit**

```bash
git add apps/expo/app/\(app\)/shortcut-web.tsx \
        apps/expo/app/\(app\)/_layout.tsx \
        apps/expo/src/features/shortcuts/ShortcutWebScreen.tsx
git commit -m "feat(expo): in-app ShortcutWebScreen with full chrome"
```

---

## Task C.3: Route URL shortcuts to the in-app webview

**Files:**
- Modify: `apps/expo/src/features/shortcuts/ShortcutsDrawer.tsx`
- Test: `apps/expo/src/test/shortcut-target.test.ts`

- [ ] **Step 1: Write failing test for `openShortcutTarget`**

```ts
// apps/expo/src/test/shortcut-target.test.ts
import { describe, expect, it, vi } from "vitest";

import { openShortcutTarget } from "../features/shortcuts/ShortcutsDrawer";
import type { Shortcut } from "../features/shortcuts/shortcut-types";

function shortcut(over: Partial<Shortcut>): Shortcut {
  return {
    id: "x", scope: "team", parentId: null, label: "X", nodeType: "url",
    target: "", order: 0, ...over,
  } as Shortcut;
}

describe("openShortcutTarget", () => {
  it("routes a session shortcut to the session route", async () => {
    const router = { push: vi.fn() };
    await openShortcutTarget(shortcut({ nodeType: "session", target: "session-123" }), router);
    expect(router.push).toHaveBeenCalledWith("/(app)/sessions/session-123");
  });

  it("routes a url shortcut to the in-app webview modal", async () => {
    const router = { push: vi.fn() };
    await openShortcutTarget(shortcut({ nodeType: "url", target: "https://example.com", label: "Hi" }), router);
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/(app)/shortcut-web",
      params: { url: "https://example.com", title: "Hi" },
    });
  });

  it("routes an external shortcut through the webview as well", async () => {
    const router = { push: vi.fn() };
    await openShortcutTarget(shortcut({ nodeType: "external", target: "https://example.com" }), router);
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/(app)/shortcut-web",
      params: { url: "https://example.com", title: "X" },
    });
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @teamclaw/expo test src/test/shortcut-target.test.ts`
Expected: FAIL — current `openShortcutTarget` calls `Linking.openURL` for URLs.

- [ ] **Step 3: Update `openShortcutTarget`**

Replace lines 374-393 of `ShortcutsDrawer.tsx`:

```ts
export async function openShortcutTarget(
  shortcut: Shortcut,
  router: { push: (href: string | { pathname: string; params: Record<string, string> }) => void },
) {
  if (!shortcut.target) return;
  if (shortcut.nodeType === "session") {
    router.push(`/(app)/sessions/${shortcut.target}`);
    return;
  }
  if (shortcut.nodeType === "url" || shortcut.nodeType === "external") {
    router.push({
      pathname: "/(app)/shortcut-web",
      params: { url: shortcut.target, title: shortcut.label },
    });
    return;
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `pnpm --filter @teamclaw/expo test src/test/shortcut-target.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/expo/src/features/shortcuts/ShortcutsDrawer.tsx \
        apps/expo/src/test/shortcut-target.test.ts
git commit -m "feat(expo): URL/external shortcuts open in-app webview"
```

---

# Phase D — ConnectedAgentsStore + Runtime State

## Task D.1: Types + Supabase API

**Files:**
- Create: `apps/expo/src/features/actors/connected-agent-types.ts`
- Create: `apps/expo/src/features/actors/agent-access-api.ts`
- Test: `apps/expo/src/test/agent-access-api.test.ts`

- [ ] **Step 1: Define types**

```ts
// apps/expo/src/features/actors/connected-agent-types.ts
export type ConnectedAgent = {
  agentId: string;
  displayName: string;
  agentKind: string;
  permissionLevel: string;
  visibility: "team" | "personal";
  isOwner: boolean;
  deviceId: string | null;
  lastActiveAt: string | null;
};

export type RuntimeInfo = {
  runtimeId: string;
  status: number;
  currentModel: string;
  availableModels: { id: string; displayName: string }[];
  sessionTitle?: string;
  currentPrompt?: string;
  agentType: number;
};

export type AgentAuthorizedHuman = {
  id: string;
  displayName: string;
  permissionLevel: string;
  grantedByActorId: string | null;
  lastActiveAt: string | null;
};
```

- [ ] **Step 2: Write failing tests for API mapping**

```ts
// apps/expo/src/test/agent-access-api.test.ts
import { describe, expect, it, vi } from "vitest";

import { createAgentAccessApi } from "../features/actors/agent-access-api";
import type { SupabaseClient } from "@supabase/supabase-js";

function fakeClient(rpc: (name: string, args?: object) => Promise<{ data: unknown; error: null }>): SupabaseClient {
  return { rpc } as unknown as SupabaseClient;
}

describe("createAgentAccessApi", () => {
  it("listConnectedAgents maps snake_case rows", async () => {
    const client = fakeClient(async (_name, _args) => ({
      data: [
        {
          agent_id: "a1", display_name: "Claude", agent_kind: "claude",
          permission_level: "team", visibility: "team", is_owner: true,
          device_id: "dev1", last_active_at: "2026-05-20T10:00:00.000Z",
        },
      ],
      error: null,
    }));
    const api = createAgentAccessApi(client);
    const rows = await api.listConnectedAgents("team1");
    expect(rows[0]).toEqual({
      agentId: "a1",
      displayName: "Claude",
      agentKind: "claude",
      permissionLevel: "team",
      visibility: "team",
      isOwner: true,
      deviceId: "dev1",
      lastActiveAt: "2026-05-20T10:00:00.000Z",
    });
  });

  it("shareAgentToTeam throws on RPC error", async () => {
    const client = fakeClient(async () => ({ data: null, error: { message: "denied" } as unknown as null }));
    const api = createAgentAccessApi(client);
    await expect(api.shareAgentToTeam("a1")).rejects.toThrow("denied");
  });
});
```

- [ ] **Step 3: Run — expect failure**

Run: `pnpm --filter @teamclaw/expo test src/test/agent-access-api.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement API**

```ts
// apps/expo/src/features/actors/agent-access-api.ts
import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  AgentAuthorizedHuman,
  ConnectedAgent,
} from "./connected-agent-types";

function mapAgent(row: Record<string, unknown>): ConnectedAgent {
  return {
    agentId: String(row.agent_id ?? ""),
    displayName: String(row.display_name ?? ""),
    agentKind: String(row.agent_kind ?? ""),
    permissionLevel: String(row.permission_level ?? "prompt"),
    visibility: (String(row.visibility ?? "team") as "team" | "personal"),
    isOwner: Boolean(row.is_owner),
    deviceId: row.device_id != null ? String(row.device_id) : null,
    lastActiveAt: row.last_active_at != null ? String(row.last_active_at) : null,
  };
}

export type AgentAccessApi = {
  listConnectedAgents: (teamId: string) => Promise<ConnectedAgent[]>;
  shareAgentToTeam: (agentId: string) => Promise<void>;
  makeAgentPersonal: (agentId: string) => Promise<void>;
  listAuthorizedHumans: (agentId: string) => Promise<AgentAuthorizedHuman[]>;
  grantAuthorizedHuman: (agentId: string, memberId: string, permissionLevel: string) => Promise<void>;
};

export function createAgentAccessApi(client: SupabaseClient): AgentAccessApi {
  async function callRpc(name: string, args: object): Promise<unknown> {
    const result = await client.rpc(name, args);
    if (result.error) throw new Error(result.error.message ?? "RPC failed");
    return result.data;
  }
  return {
    async listConnectedAgents(teamId) {
      const data = await callRpc("list_connected_agents", { p_team_id: teamId });
      if (!Array.isArray(data)) return [];
      return data.map((row) => mapAgent(row as Record<string, unknown>));
    },
    async shareAgentToTeam(agentId) {
      await callRpc("share_agent_to_team", { p_agent_id: agentId });
    },
    async makeAgentPersonal(agentId) {
      await callRpc("make_agent_personal", { p_agent_id: agentId });
    },
    async listAuthorizedHumans(agentId) {
      const data = await callRpc("list_authorized_humans", { p_agent_id: agentId });
      if (!Array.isArray(data)) return [];
      return data.map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          id: String(row.member_id ?? ""),
          displayName: String(row.display_name ?? ""),
          permissionLevel: String(row.permission_level ?? "prompt"),
          grantedByActorId: row.granted_by_actor_id != null ? String(row.granted_by_actor_id) : null,
          lastActiveAt: row.last_active_at != null ? String(row.last_active_at) : null,
        };
      });
    },
    async grantAuthorizedHuman(agentId, memberId, permissionLevel) {
      await callRpc("grant_authorized_human", {
        p_agent_id: agentId, p_member_id: memberId, p_permission_level: permissionLevel,
      });
    },
  };
}
```

- [ ] **Step 5: Run — expect pass**

Run: `pnpm --filter @teamclaw/expo test src/test/agent-access-api.test.ts`
Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/expo/src/features/actors/connected-agent-types.ts \
        apps/expo/src/features/actors/agent-access-api.ts \
        apps/expo/src/test/agent-access-api.test.ts
git commit -m "feat(expo): connected-agent types + agent access RPC client"
```

---

## Task D.2: Online derivation helper

**Files:**
- Modify: `apps/expo/src/features/actors/connected-agent-types.ts`
- Test: `apps/expo/src/test/is-agent-online.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// apps/expo/src/test/is-agent-online.test.ts
import { describe, expect, it } from "vitest";

import { isAgentOnline } from "../features/actors/connected-agent-types";

const NOW = new Date("2026-05-20T10:00:00.000Z").getTime();

describe("isAgentOnline", () => {
  it("returns false when lastActiveAt is null", () => {
    expect(isAgentOnline({ lastActiveAt: null } as any, NOW)).toBe(false);
  });
  it("returns true when within 120s window", () => {
    const at = new Date(NOW - 119_000).toISOString();
    expect(isAgentOnline({ lastActiveAt: at } as any, NOW)).toBe(true);
  });
  it("returns false at the boundary", () => {
    const at = new Date(NOW - 120_000).toISOString();
    expect(isAgentOnline({ lastActiveAt: at } as any, NOW)).toBe(false);
  });
  it("returns false for malformed strings", () => {
    expect(isAgentOnline({ lastActiveAt: "nope" } as any, NOW)).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @teamclaw/expo test src/test/is-agent-online.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the helper**

Append to `connected-agent-types.ts`:

```ts
export function isAgentOnline(agent: Pick<ConnectedAgent, "lastActiveAt">, now = Date.now()): boolean {
  if (!agent.lastActiveAt) return false;
  const t = Date.parse(agent.lastActiveAt);
  if (!Number.isFinite(t)) return false;
  return now - t < 120_000;
}
```

- [ ] **Step 4: Run — expect pass**

Run: `pnpm --filter @teamclaw/expo test src/test/is-agent-online.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/expo/src/features/actors/connected-agent-types.ts \
        apps/expo/src/test/is-agent-online.test.ts
git commit -m "feat(expo): isAgentOnline helper (120s window)"
```

---

## Task D.3: Runtime state subscriber

**Files:**
- Create: `apps/expo/src/features/actors/runtime-state-subscriber.ts`
- Test: `apps/expo/src/test/runtime-state-subscriber.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// apps/expo/src/test/runtime-state-subscriber.test.ts
import { describe, expect, it, vi } from "vitest";

import type { TeamMqttClient } from "../lib/mqtt/team-mqtt";
import { createRuntimeStateSubscriber } from "../features/actors/runtime-state-subscriber";

function fakeMqtt(): TeamMqttClient & { fire: (topic: string, payload: Uint8Array) => void } {
  const handlers = new Map<string, (p: Uint8Array, t: string) => void>();
  return {
    async start() {},
    subscribe(filter, handler) {
      handlers.set(filter, handler);
      return () => { handlers.delete(filter); };
    },
    async publish() {},
    onConnectionState() { return () => {}; },
    async dispose() { handlers.clear(); },
    fire(topic, payload) {
      for (const [filter, handler] of handlers) {
        // crude: only matches if filter contains "+/state" and ends correctly
        if (topic.includes("/runtime/") && topic.endsWith("/state")) handler(payload, topic);
      }
    },
  };
}

describe("RuntimeStateSubscriber", () => {
  it("watchDevice subscribes to the device-scoped wildcard", () => {
    const mqtt = fakeMqtt();
    const subscribeSpy = vi.spyOn(mqtt, "subscribe");
    const sub = createRuntimeStateSubscriber({
      mqtt, teamId: "team1",
      decode: () => ({ runtimeId: "r1", status: 1, currentModel: "", availableModels: [], agentType: 1 }),
      onRuntimeInfo: () => {},
    });
    sub.watchDevice("dev1");
    expect(subscribeSpy).toHaveBeenCalledWith(
      "amux/team1/device/dev1/runtime/+/state",
      expect.any(Function),
    );
  });

  it("invokes onRuntimeInfo with (deviceId, runtimeId, info) extracted from the topic", () => {
    const mqtt = fakeMqtt();
    const cb = vi.fn();
    const decodedInfo = { runtimeId: "rt-from-decode", status: 5, currentModel: "m", availableModels: [], agentType: 1 };
    const sub = createRuntimeStateSubscriber({
      mqtt, teamId: "team1",
      decode: () => decodedInfo,
      onRuntimeInfo: cb,
    });
    sub.watchDevice("dev1");
    mqtt.fire("amux/team1/device/dev1/runtime/r-topic/state", new Uint8Array([1, 2]));
    expect(cb).toHaveBeenCalledWith("dev1", "r-topic", decodedInfo);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @teamclaw/expo test src/test/runtime-state-subscriber.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/expo/src/features/actors/runtime-state-subscriber.ts
import { extractWildcards } from "../../lib/mqtt/topic-match";
import type { TeamMqttClient } from "../../lib/mqtt/team-mqtt";
import type { RuntimeInfo } from "./connected-agent-types";

export type RuntimeStateSubscriber = {
  watchDevice: (deviceId: string) => void;
  unwatchDevice: (deviceId: string) => void;
  watchedDevices: () => Set<string>;
  dispose: () => void;
};

type Deps = {
  mqtt: TeamMqttClient;
  teamId: string;
  decode: (payload: Uint8Array) => RuntimeInfo | null;
  onRuntimeInfo: (deviceId: string, runtimeId: string, info: RuntimeInfo) => void;
};

export function createRuntimeStateSubscriber(deps: Deps): RuntimeStateSubscriber {
  const unsubscribes = new Map<string, () => void>();

  function topicFor(deviceId: string) {
    return `amux/${deps.teamId}/device/${deviceId}/runtime/+/state`;
  }

  return {
    watchDevice(deviceId) {
      if (unsubscribes.has(deviceId)) return;
      const filter = topicFor(deviceId);
      const off = deps.mqtt.subscribe(filter, (payload, topic) => {
        const segments = extractWildcards(
          `amux/${deps.teamId}/device/+/runtime/+/state`,
          topic,
        );
        if (!segments) return;
        const [, runtimeId] = segments;
        const info = deps.decode(payload);
        if (!info) return;
        deps.onRuntimeInfo(deviceId, runtimeId, info);
      });
      unsubscribes.set(deviceId, off);
    },
    unwatchDevice(deviceId) {
      const off = unsubscribes.get(deviceId);
      if (off) { off(); unsubscribes.delete(deviceId); }
    },
    watchedDevices() {
      return new Set(unsubscribes.keys());
    },
    dispose() {
      for (const off of unsubscribes.values()) off();
      unsubscribes.clear();
    },
  };
}
```

- [ ] **Step 4: Run — expect pass**

Run: `pnpm --filter @teamclaw/expo test src/test/runtime-state-subscriber.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/expo/src/features/actors/runtime-state-subscriber.ts \
        apps/expo/src/test/runtime-state-subscriber.test.ts
git commit -m "feat(expo): runtime/+/state MQTT subscriber per device"
```

---

## Task D.4: Connected agents sqlite cache

**Files:**
- Create: `apps/expo/src/features/actors/connected-agents-cache.ts`
- Test: `apps/expo/src/test/connected-agents-cache.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// apps/expo/src/test/connected-agents-cache.test.ts
import { describe, expect, it } from "vitest";

import { createConnectedAgentsCache } from "../features/actors/connected-agents-cache";

function fakeDb() {
  const rows: any[] = [];
  return {
    rows,
    async runAsync(sql: string, ...params: unknown[]) {
      if (/^DELETE FROM connected_agents WHERE team_id = \?/i.test(sql)) {
        const [teamId] = params;
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i].team_id === teamId) rows.splice(i, 1);
        return;
      }
      if (/^INSERT INTO connected_agents/i.test(sql)) {
        const [
          team_id, agent_id, display_name, agent_kind, permission_level,
          visibility, is_owner, device_id, last_active_at, current_model,
          status, updated_at,
        ] = params;
        rows.push({ team_id, agent_id, display_name, agent_kind, permission_level,
          visibility, is_owner, device_id, last_active_at, current_model, status, updated_at });
        return;
      }
      throw new Error("unhandled: " + sql);
    },
    async getAllAsync(_sql: string, ...params: unknown[]) {
      return rows.filter((r) => r.team_id === params[0]);
    },
  };
}

describe("connected-agents cache", () => {
  it("saveCache replaces all rows for a team", async () => {
    const db = fakeDb();
    const cache = createConnectedAgentsCache(db as any);
    await cache.saveCache("t1", [
      { agentId: "a1", displayName: "Claude", agentKind: "claude",
        permissionLevel: "team", visibility: "team", isOwner: true,
        deviceId: "d1", lastActiveAt: "2026-05-20T10:00:00.000Z" },
    ]);
    expect(db.rows.length).toBe(1);
    await cache.saveCache("t1", []);
    expect(db.rows.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @teamclaw/expo test src/test/connected-agents-cache.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement cache**

```ts
// apps/expo/src/features/actors/connected-agents-cache.ts
import type { ConnectedAgent } from "./connected-agent-types";

export type ConnectedAgentsCacheDb = {
  runAsync: (sql: string, ...params: unknown[]) => Promise<unknown>;
  getAllAsync: (sql: string, ...params: unknown[]) => Promise<Record<string, unknown>[]>;
};

export type ConnectedAgentsCache = {
  loadCache: (teamId: string) => Promise<ConnectedAgent[]>;
  saveCache: (teamId: string, agents: ConnectedAgent[]) => Promise<void>;
};

export function createConnectedAgentsCache(db: ConnectedAgentsCacheDb): ConnectedAgentsCache {
  return {
    async loadCache(teamId) {
      const rows = await db.getAllAsync(`SELECT * FROM connected_agents WHERE team_id = ?`, teamId);
      return rows.map((r) => ({
        agentId: String(r.agent_id),
        displayName: String(r.display_name),
        agentKind: String(r.agent_kind),
        permissionLevel: String(r.permission_level),
        visibility: r.visibility === "personal" ? "personal" : "team",
        isOwner: r.is_owner === 1 || r.is_owner === true,
        deviceId: r.device_id != null ? String(r.device_id) : null,
        lastActiveAt: r.last_active_at != null ? new Date(Number(r.last_active_at)).toISOString() : null,
      }));
    },
    async saveCache(teamId, agents) {
      await db.runAsync(`DELETE FROM connected_agents WHERE team_id = ?`, teamId);
      const now = Date.now();
      for (const a of agents) {
        await db.runAsync(
          `INSERT INTO connected_agents (
             team_id, agent_id, display_name, agent_kind, permission_level,
             visibility, is_owner, device_id, last_active_at, current_model, status, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          teamId, a.agentId, a.displayName, a.agentKind, a.permissionLevel,
          a.visibility, a.isOwner ? 1 : 0,
          a.deviceId,
          a.lastActiveAt ? Date.parse(a.lastActiveAt) : null,
          null, null, now,
        );
      }
    },
  };
}
```

- [ ] **Step 4: Run — expect pass**

Run: `pnpm --filter @teamclaw/expo test src/test/connected-agents-cache.test.ts`
Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add apps/expo/src/features/actors/connected-agents-cache.ts \
        apps/expo/src/test/connected-agents-cache.test.ts
git commit -m "feat(expo): sqlite cache for connected agents (cold-start paint)"
```

---

## Task D.5: ConnectedAgentsStore

**Files:**
- Create: `apps/expo/src/features/actors/connected-agents-store.ts`
- Test: `apps/expo/src/test/connected-agents-store.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// apps/expo/src/test/connected-agents-store.test.ts
import { describe, expect, it, vi } from "vitest";

import { createConnectedAgentsStore } from "../features/actors/connected-agents-store";
import type { AgentAccessApi } from "../features/actors/agent-access-api";
import type { ConnectedAgent } from "../features/actors/connected-agent-types";

function fakeApi(agents: ConnectedAgent[]): AgentAccessApi {
  return {
    listConnectedAgents: vi.fn().mockResolvedValue(agents),
    shareAgentToTeam: vi.fn().mockResolvedValue(undefined),
    makeAgentPersonal: vi.fn().mockResolvedValue(undefined),
    listAuthorizedHumans: vi.fn().mockResolvedValue([]),
    grantAuthorizedHuman: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeSubscriber() {
  const watched = new Set<string>();
  return {
    watchDevice: (id: string) => { watched.add(id); },
    unwatchDevice: (id: string) => { watched.delete(id); },
    watchedDevices: () => new Set(watched),
    dispose: () => watched.clear(),
  };
}

describe("ConnectedAgentsStore", () => {
  it("reload populates agents and watches each device", async () => {
    const agents: ConnectedAgent[] = [
      { agentId: "a1", displayName: "Claude", agentKind: "claude",
        permissionLevel: "team", visibility: "team", isOwner: true,
        deviceId: "d1", lastActiveAt: null },
      { agentId: "a2", displayName: "Codex", agentKind: "codex",
        permissionLevel: "team", visibility: "team", isOwner: true,
        deviceId: "d2", lastActiveAt: null },
    ];
    const sub = fakeSubscriber();
    const store = createConnectedAgentsStore({
      teamId: "t", api: fakeApi(agents), subscriber: sub,
    });
    await store.reload();
    expect(store.getState().agents.map((a) => a.agentId)).toEqual(["a1", "a2"]);
    expect(Array.from(sub.watchedDevices())).toEqual(["d1", "d2"]);
  });

  it("reload diff: removes watch for dropped device", async () => {
    const sub = fakeSubscriber();
    const initial: ConnectedAgent[] = [
      { agentId: "a1", displayName: "Claude", agentKind: "claude",
        permissionLevel: "team", visibility: "team", isOwner: true,
        deviceId: "d1", lastActiveAt: null },
    ];
    const api = fakeApi(initial);
    const store = createConnectedAgentsStore({ teamId: "t", api, subscriber: sub });
    await store.reload();
    expect(sub.watchedDevices().has("d1")).toBe(true);
    (api.listConnectedAgents as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    await store.reload();
    expect(sub.watchedDevices().has("d1")).toBe(false);
  });

  it("runtime info handler updates lastActiveAt and runtimeInfoByAgentId", async () => {
    const sub = fakeSubscriber();
    const agents: ConnectedAgent[] = [
      { agentId: "a1", displayName: "Claude", agentKind: "claude",
        permissionLevel: "team", visibility: "team", isOwner: true,
        deviceId: "d1", lastActiveAt: null },
    ];
    const store = createConnectedAgentsStore({ teamId: "t", api: fakeApi(agents), subscriber: sub });
    await store.reload();
    store.handleRuntimeInfo("d1", "r1", {
      runtimeId: "r1", status: 1, currentModel: "claude-sonnet-4-6",
      availableModels: [], agentType: 1,
    });
    expect(store.getState().runtimeInfoByAgentId.get("a1")?.currentModel).toBe("claude-sonnet-4-6");
    expect(store.getState().agents[0].lastActiveAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @teamclaw/expo test src/test/connected-agents-store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement store**

```ts
// apps/expo/src/features/actors/connected-agents-store.ts
import type { AgentAccessApi } from "./agent-access-api";
import type { ConnectedAgentsCache } from "./connected-agents-cache";
import type {
  ConnectedAgent,
  RuntimeInfo,
} from "./connected-agent-types";

export type ConnectedAgentsStoreState = {
  agents: ConnectedAgent[];
  runtimeInfoByAgentId: ReadonlyMap<string, RuntimeInfo>;
  isLoading: boolean;
  errorMessage: string | null;
};

type Subscriber = {
  watchDevice: (deviceId: string) => void;
  unwatchDevice: (deviceId: string) => void;
  watchedDevices: () => Set<string>;
  dispose: () => void;
};

type Deps = {
  teamId: string;
  api: AgentAccessApi;
  subscriber: Subscriber;
  cache?: ConnectedAgentsCache;
};

export type ConnectedAgentsStore = {
  subscribe: (listener: () => void) => () => void;
  getState: () => ConnectedAgentsStoreState;
  reload: () => Promise<void>;
  shareToTeam: (agentId: string) => Promise<boolean>;
  makePersonal: (agentId: string) => Promise<boolean>;
  handleRuntimeInfo: (deviceId: string, runtimeId: string, info: RuntimeInfo) => void;
  dispose: () => Promise<void>;
};

const EMPTY_MAP: ReadonlyMap<string, RuntimeInfo> = new Map();

export function createConnectedAgentsStore(deps: Deps): ConnectedAgentsStore {
  let state: ConnectedAgentsStoreState = {
    agents: [],
    runtimeInfoByAgentId: EMPTY_MAP,
    isLoading: false,
    errorMessage: null,
  };
  const listeners = new Set<() => void>();

  function setState(next: ConnectedAgentsStoreState) {
    state = next;
    for (const l of listeners) l();
  }

  function diffWatches(prev: ConnectedAgent[], next: ConnectedAgent[]) {
    const prevDevices = new Set(prev.map((a) => a.deviceId).filter(Boolean) as string[]);
    const nextDevices = new Set(next.map((a) => a.deviceId).filter(Boolean) as string[]);
    for (const id of prevDevices) if (!nextDevices.has(id)) deps.subscriber.unwatchDevice(id);
    for (const id of nextDevices) if (!prevDevices.has(id)) deps.subscriber.watchDevice(id);
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState() { return state; },
    async reload() {
      setState({ ...state, isLoading: true, errorMessage: null });
      try {
        const agents = await deps.api.listConnectedAgents(deps.teamId);
        diffWatches(state.agents, agents);
        setState({ ...state, agents, isLoading: false, errorMessage: null });
        void deps.cache?.saveCache(deps.teamId, agents);
      } catch (err) {
        setState({
          ...state,
          isLoading: false,
          errorMessage: err instanceof Error ? err.message : "Couldn't load agents.",
        });
      }
    },
    async shareToTeam(agentId) {
      try { await deps.api.shareAgentToTeam(agentId); await this.reload(); return true; }
      catch (err) {
        setState({ ...state, errorMessage: err instanceof Error ? err.message : "Failed." });
        return false;
      }
    },
    async makePersonal(agentId) {
      try { await deps.api.makeAgentPersonal(agentId); await this.reload(); return true; }
      catch (err) {
        setState({ ...state, errorMessage: err instanceof Error ? err.message : "Failed." });
        return false;
      }
    },
    handleRuntimeInfo(deviceId, _runtimeId, info) {
      const agentIdx = state.agents.findIndex((a) => a.deviceId === deviceId);
      if (agentIdx < 0) return;
      const next = state.agents.slice();
      next[agentIdx] = { ...next[agentIdx], lastActiveAt: new Date().toISOString() };
      const map = new Map(state.runtimeInfoByAgentId);
      map.set(next[agentIdx].agentId, info);
      setState({ ...state, agents: next, runtimeInfoByAgentId: map });
    },
    async dispose() {
      deps.subscriber.dispose();
      listeners.clear();
    },
  };
}
```

- [ ] **Step 4: Run — expect pass**

Run: `pnpm --filter @teamclaw/expo test src/test/connected-agents-store.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/expo/src/features/actors/connected-agents-store.ts \
        apps/expo/src/test/connected-agents-store.test.ts
git commit -m "feat(expo): ConnectedAgentsStore + runtime info reconciliation"
```

---

## Task D.6: Wire team-mqtt + store into _layout.tsx

**Files:**
- Modify: `apps/expo/app/_layout.tsx`

- [ ] **Step 1: Construct + dispose lifecycle**

In `_layout.tsx`, after the onboarding state transitions to `ready` with a `currentTeam`, build the shared MQTT client + ConnectedAgentsStore.

Add to existing imports:

```ts
import { createTeamMqttClient } from "../src/lib/mqtt/team-mqtt";
import { createAgentAccessApi } from "../src/features/actors/agent-access-api";
import { createRuntimeStateSubscriber } from "../src/features/actors/runtime-state-subscriber";
import { createConnectedAgentsStore } from "../src/features/actors/connected-agents-store";
import { createConnectedAgentsCache } from "../src/features/actors/connected-agents-cache";
import { getDb } from "../src/lib/db/sqlite";
import { decodeRuntimeInfo } from "../src/lib/teamclaw/runtime-info";  // added in step 2
import { mqttUrl } from "../src/lib/mqtt/config";
```

Inside the layout component, after `useOnboarding` resolves to ready:

```ts
const teamMqttRef = useRef<ReturnType<typeof createTeamMqttClient> | null>(null);
const storeRef = useRef<ReturnType<typeof createConnectedAgentsStore> | null>(null);

useEffect(() => {
  if (state.route !== "ready" || !state.currentTeam || !state.currentMemberActorId) return;
  let disposed = false;
  void (async () => {
    const auth = await state.controller.getAuth();
    if (!auth.accessToken || !mqttUrl) return;
    const mqtt = createTeamMqttClient({
      url: mqttUrl,
      username: state.currentMemberActorId,
      password: auth.accessToken,
      clientId: `teamclaw-expo-${state.currentMemberActorId.slice(0, 8)}`,
    });
    await mqtt.start();
    if (disposed) { await mqtt.dispose(); return; }
    teamMqttRef.current = mqtt;

    const db = await getDb();
    const cache = createConnectedAgentsCache(db);
    const subscriber = createRuntimeStateSubscriber({
      mqtt, teamId: state.currentTeam.id,
      decode: decodeRuntimeInfo,
      onRuntimeInfo: (deviceId, runtimeId, info) => storeRef.current?.handleRuntimeInfo(deviceId, runtimeId, info),
    });
    const store = createConnectedAgentsStore({
      teamId: state.currentTeam.id,
      api: createAgentAccessApi(supabase),
      subscriber,
      cache,
    });
    storeRef.current = store;
    await store.reload();
  })();
  return () => {
    disposed = true;
    void storeRef.current?.dispose();
    void teamMqttRef.current?.dispose();
    storeRef.current = null;
    teamMqttRef.current = null;
  };
}, [state.route, state.currentTeam?.id, state.currentMemberActorId]);
```

- [ ] **Step 2: Add a placeholder `decodeRuntimeInfo`**

```ts
// apps/expo/src/lib/teamclaw/runtime-info.ts
import { fromBinary } from "@bufbuild/protobuf";
// Replace with the real proto import once the schema is generated for Expo.
import type { RuntimeInfo } from "../../features/actors/connected-agent-types";

export function decodeRuntimeInfo(_payload: Uint8Array): RuntimeInfo | null {
  // TODO replace with: fromBinary(RuntimeInfoSchema, _payload).
  // Returns null until proto wiring lands so wire path is exercised without
  // crashing on malformed payloads.
  return null;
}
```

This is the only TODO in the plan and is acceptable because it's gated by an external proto schema that lives in `packages/app/src/proto` — the wire path is otherwise complete. A follow-up task swaps the body for the real decoder once the schema is exported.

- [ ] **Step 3: Type-check**

Run: `pnpm --filter @teamclaw/expo exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/expo/app/_layout.tsx apps/expo/src/lib/teamclaw/runtime-info.ts
git commit -m "feat(expo): host shared team MQTT + ConnectedAgentsStore in root layout"
```

---

## Task D.7: Refactor session-detail-controller to consume shared TeamMqttClient

**Files:**
- Modify: `apps/expo/src/features/sessions/session-detail-controller.ts`
- Modify: `apps/expo/app/(app)/(tabs)/sessions/[sessionId].tsx`

- [ ] **Step 1: Change controller deps**

In `session-detail-controller.ts`, replace the existing `mqtt: Pick<ExpoMqttAdapter, ...>` dep with:

```ts
import type { TeamMqttClient } from "../../lib/mqtt/team-mqtt";

type SessionDetailControllerDeps = {
  // … existing fields except mqtt
  mqtt: Pick<TeamMqttClient, "subscribe" | "publish" | "onConnectionState">;
  // … rest
};
```

Inside `connectRealtime`, replace the `await deps.mqtt.connect(...)` block with:

```ts
const unsubscribeFromTopic = deps.mqtt.subscribe(
  `amux/${deps.teamId}/session/${deps.sessionId}/live`,
  (payload) => {
    const decoded = decodeLiveEvent(payload);
    if (!decoded?.message) return;
    // existing decode + reduce logic
  },
);
cleanupMessageListener = unsubscribeFromTopic;
```

Remove the explicit `await deps.mqtt.subscribe(topic)` followup. Connection state is read via `deps.mqtt.onConnectionState(...)` and reflected as before.

In `disconnectRealtime`, just invoke `cleanupMessageListener?.()` and remove the `await deps.mqtt.disconnect()` call (the team client lives longer than the controller).

- [ ] **Step 2: Wire the team mqtt client at the route**

In `apps/expo/app/(app)/(tabs)/sessions/[sessionId].tsx`, read the shared MQTT client from the layout context (or via a small `useTeamMqttClient()` hook exposed by `_layout.tsx`) and pass it as `deps.mqtt` instead of constructing an `ExpoMqttAdapter`.

- [ ] **Step 3: Type-check + tests**

Run: `pnpm --filter @teamclaw/expo exec tsc --noEmit`
Run: `pnpm --filter @teamclaw/expo test src/test/session-detail-controller.test.ts`
Expected: both PASS. Existing controller tests use a mock — update them to expose the new `subscribe(filter, handler) → unsubscribe` shape.

- [ ] **Step 4: Commit**

```bash
git add apps/expo/src/features/sessions/session-detail-controller.ts \
        apps/expo/app/\(app\)/\(tabs\)/sessions/\[sessionId\].tsx \
        apps/expo/src/test/session-detail-controller.test.ts
git commit -m "feat(expo): session-detail-controller consumes shared team MQTT client"
```

---

# Final Pass

## Task FINAL.1: Run the full test suite

- [ ] **Step 1: Run**

Run: `pnpm --filter @teamclaw/expo test`
Expected: all tests pass — including pre-existing ones touched (`session-detail-controller`, `session-api`, etc.).

- [ ] **Step 2: Type-check the whole package**

Run: `pnpm --filter @teamclaw/expo exec tsc --noEmit`
Expected: 0 errors.

## Task FINAL.2: Smoke + commit lock

- [ ] **Step 1: Cold-start the app**

Run: `pnpm --filter @teamclaw/expo dev`. Sign in. Verify:
- Sessions list loads from sqlite cache instantly.
- Sending a message shows the outbox dot transition (sending → sent).
- Killing the app mid-send: relaunch retries automatically.
- A URL shortcut opens in-app in `shortcut-web` modal.
- ActorsListScreen shows online dot for agents that recently published runtime state.

- [ ] **Step 2: No new commits needed; ensure branch is clean**

Run: `git status`
Expected: clean working tree.

---

## Self-Review

**Spec coverage:**
- §3 Outbox — Tasks A.1–A.6 cover schema, DAO, sender, store, controller wiring, UI retry.
- §4 Reducer — Tasks B.1–B.5 cover types, messageCommitted, streamingDelta, streamingDone, controller integration, rendering.
- §5 WebView — Tasks C.1–C.3 cover dependency, modal route, screen, drawer routing.
- §6 ConnectedAgents — Tasks D.1–D.7 cover types, API, online derivation, MQTT subscriber, cache, store, root layout wiring, controller refactor onto shared client.
- §2 Shared infra — Tasks 0.1–0.4 cover sqlite + team-mqtt.

**Placeholder scan:**
- One TODO in Task D.6 / `decodeRuntimeInfo` is explicitly flagged and gated on the proto schema export. All other steps contain concrete code.

**Type consistency:**
- `OutboxRow` / `NewOutboxRow` / `OutboxDao` / `OutboxState` are stable across A.2, A.3, A.5.
- `TimelineState` / `StreamingBuffer` / `TimelineEvent` are stable across B.1–B.5.
- `ConnectedAgent` / `RuntimeInfo` are stable across D.1–D.7.
- `TeamMqttClient.subscribe` returns `() => void` everywhere it's referenced.
