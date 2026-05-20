# Expo / iOS Parity Batch 2: Outbox · Streaming · WebView · ConnectedAgents

**Status:** Draft (awaiting user review)
**Date:** 2026-05-20
**Branch:** `fix/expo` (worktree `.worktrees/fix-expo`)
**Predecessor specs:** [2026-05-19-expo-ios-full-parity-roadmap.md](2026-05-19-expo-ios-full-parity-roadmap.md), [2026-05-18-expo-session-messages-design.md](2026-05-18-expo-session-messages-design.md)

## 1. Goal

Bring four iOS-only behaviors to the Expo (Android) client at 1:1 parity:

1. **Durable outbox with retry** — survive process death, auto-retry transient send failures with exponential backoff.
2. **Multi-agent streaming reducer** — fix the current bug where same-`messageId` updates are dropped, and add per-agent in-flight draft buffers so concurrent agent streams render correctly.
3. **ShortcutWebView** — open URL/external shortcuts in an in-app WebView with full chrome (close / back / forward / reload / share / loading bar), instead of jumping out to the system browser.
4. **ConnectedAgentsStore + real-time runtime state** — load connected agents from Supabase and subscribe to `amux/{teamID}/device/{deviceID}/runtime/+/state` MQTT wildcard so agent online status and current model update live.

Out of scope (deferred): Apple/Google sign-in, persistent splash, dark mode tokens, push presence heartbeat, MQTTTraceRecorder.

## 2. Shared Infrastructure

Two pieces of infrastructure are introduced first because Sections A, B, and D depend on them.

### 2.1 expo-sqlite singleton (`apps/expo/src/lib/db/sqlite.ts`)

A single SQLite database file shared by Outbox (A) and ConnectedAgents cache (D). New dependency: `expo-sqlite`.

```ts
// apps/expo/src/lib/db/sqlite.ts
import * as SQLite from "expo-sqlite";

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync("teamclaw.db").then(async (db) => {
      await db.execAsync("PRAGMA journal_mode = WAL;");
      await runMigrations(db);
      return db;
    });
  }
  return dbPromise;
}
```

Migrations live in `apps/expo/src/lib/db/migrations.ts`, run sequentially by version. Initial migration creates the `outbox` and `connected_agents` tables.

### 2.2 Team-scoped MQTT singleton (`apps/expo/src/lib/mqtt/team-mqtt.ts`)

Today both the session-detail-controller and (after this spec) the ConnectedAgentsStore need MQTT. Sharing one connection per team avoids two parallel TCP sessions and lets all subscribers fan out from a single `onMessage` dispatcher.

```ts
type TopicHandler = (payload: Uint8Array, topic: string) => void;

export type TeamMqttClient = {
  subscribe: (topic: string, handler: TopicHandler) => () => void;
  publish: (topic: string, payload: Uint8Array, retain?: boolean) => Promise<void>;
  connectionState: "connecting" | "connected" | "disconnected";
  onConnectionState: (listener: (s: ConnectionState) => void) => () => void;
  dispose: () => Promise<void>;
};

export function createTeamMqttClient(deps: {
  url: string;
  username: string;     // actor id
  password: string;     // supabase access token
  clientId: string;
}): TeamMqttClient;
```

Dispatcher maintains `Map<topicPattern, Set<TopicHandler>>` and matches MQTT wildcards (`+`, `#`) on inbound messages. Subscribe returns an `unsubscribe` callback.

Built once per active team in `app/_layout.tsx` (alongside the existing `useOnboarding`), torn down on sign-out or team switch.

**`session-detail-controller.ts` refactor:** today it owns its own MQTT connect/disconnect (lines 209-253). After this spec it accepts a `TeamMqttClient` via deps and uses `subscribe(topic, handler)` / `publish(...)` instead. The connect/disconnect dance moves up to `_layout.tsx`. This is a real, planned edit — not optional — so the two subscriber surfaces (session + connected-agents) share one client.

## 3. Section A — Durable Outbox + Retry

### 3.1 Files

| File | Change |
|---|---|
| `apps/expo/src/lib/db/sqlite.ts` | NEW — singleton DB |
| `apps/expo/src/lib/db/migrations.ts` | NEW — outbox + connected_agents schema |
| `apps/expo/src/features/sessions/outbox-db.ts` | NEW — DAO over outbox table |
| `apps/expo/src/features/sessions/outbox-store.ts` | REWRITE — UI subscription layer reads from DB |
| `apps/expo/src/features/sessions/outbox-sender.ts` | NEW — 1s poll loop + backoff |
| `apps/expo/src/features/sessions/session-detail-controller.ts` | EDIT — `sendMessage` enqueues; sender lifecycle bound to `load`/`dispose` |

### 3.2 Schema

```sql
CREATE TABLE outbox (
  message_id          TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  team_id             TEXT NOT NULL,
  sender_actor_id     TEXT NOT NULL,
  content             TEXT NOT NULL,
  mention_actor_ids   TEXT NOT NULL DEFAULT '[]',  -- JSON
  reply_to_message_id TEXT,
  attachments         TEXT NOT NULL DEFAULT '[]',  -- JSON
  state               TEXT NOT NULL,               -- pending|inFlight|delivered|failed
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  last_attempt_at     INTEGER,
  next_attempt_at     INTEGER,                     -- null = due immediately
  created_at          INTEGER NOT NULL
);
CREATE INDEX outbox_due ON outbox(state, next_attempt_at);
```

### 3.3 DAO (`outbox-db.ts`)

```ts
export type OutboxRow = {
  messageId: string; sessionId: string; teamId: string;
  senderActorId: string; content: string;
  mentionActorIds: string[]; replyToMessageId: string | null;
  attachments: AttachmentRef[];
  state: "pending" | "inFlight" | "delivered" | "failed";
  attemptCount: number; lastError: string | null;
  lastAttemptAt: number | null; nextAttemptAt: number | null;
  createdAt: number;
};

export type NewOutboxRow = Pick<OutboxRow,
  "messageId" | "sessionId" | "teamId" | "senderActorId"
  | "content" | "mentionActorIds" | "replyToMessageId" | "attachments">;
export async function enqueue(row: NewOutboxRow): Promise<void>;  // INSERT OR IGNORE on messageId
export async function fetchDue(now: number, limit?: number): Promise<OutboxRow[]>;
export async function markInFlight(messageId: string, now: number): Promise<void>;
export async function markDelivered(messageId: string): Promise<void>;
export async function markFailedWithBackoff(messageId: string, error: string, nextAttemptAt: number, attemptCount: number): Promise<void>;
export async function markFailedExhausted(messageId: string, error: string): Promise<void>;
export async function retry(messageId: string): Promise<void>;  // failed → pending, reset attempts
export async function getByMessageId(messageId: string): Promise<OutboxRow | null>;
```

### 3.4 Store (`outbox-store.ts`) — UI subscription layer

Keeps the same public surface (`setOutboxStatus`, `clearOutboxStatus`, `getOutboxSnapshot`, `subscribeOutbox`) so `SessionMessageRow` consumers don't break. The implementation changes: instead of a `Map<messageId, status>` in memory, the snapshot is built from DAO `fetchAll()` on subscription + on every sender state transition. Sender notifies the store after `markDelivered` / `markFailed*` / `markInFlight`.

### 3.5 Sender (`outbox-sender.ts`)

```ts
export function createOutboxSender(deps: {
  api: Pick<SessionsApi, "insertOutgoingMessage">;
  mqtt: { publish: (topic: string, payload: Uint8Array) => Promise<void> };
  getAuth: () => Promise<{ accessToken: string | null; userId: string | null }>;
  resolveSenderActorId: (teamId: string) => Promise<string>;
}): {
  start: () => void;
  stop: () => void;
  enqueue: (row: NewOutboxRow) => Promise<void>;
  retry: (messageId: string) => Promise<void>;
};
```

Loop:
1. Every 1s tick: `fetchDue(Date.now())` ordered by `created_at` ASC.
2. For each row: `markInFlight` → call `api.insertOutgoingMessage` → encode proto → `mqtt.publish`.
3. On success: `markDelivered`.
4. On failure: `attemptCount += 1`; if `>= 20` → `markFailedExhausted`; else schedule retry at `now + backoff(attemptCount)`.
5. Notify outbox-store after each transition so UI dot updates.

### 3.6 Backoff

```ts
function backoff(attempt: number): number {
  const exp = Math.max(0, attempt - 1);
  const base = Math.pow(2, Math.min(exp, 6)) * 500; // ms
  return Math.min(base, 30_000);
}
// → 500ms, 1s, 2s, 4s, 8s, 16s, 30s, 30s, … capped to 30s
```

Max attempts: **20** (mirrors iOS `OutboxSender.maxAttempts`).

### 3.7 Controller integration

`session-detail-controller.ts:sendMessage` changes:

- **Before:** insert Supabase row + MQTT publish inline; set outbox status in memory.
- **After:** call `outboxSender.enqueue({ messageId, sessionId, ... })`. Sender does the rest. UI optimistic message is inserted into `messages[]` immediately (unchanged), the dot reflects DAO state.

Sender lifecycle:
- Started from the controller's `load()` (once auth/mqtt deps are ready).
- Stopped from `dispose()`.

Failed-message retry UX: `SessionMessageRow` tap on failed dot → `outboxSender.retry(messageId)`.

### 3.8 Tests

- `outbox-sender.test.ts`: backoff curve, `enqueue` idempotency on duplicate messageId, `markFailedExhausted` after 20 attempts, retry resets state.
- `outbox-db.test.ts`: `fetchDue` filtering (null `next_attempt_at` ≡ due, past timestamps included, future excluded), state transition predicates.
- `outbox-store.test.ts`: subscribe receives snapshot after sender transitions.

## 4. Section B — Multi-agent Streaming Reducer

### 4.1 Files

| File | Change |
|---|---|
| `apps/expo/src/features/sessions/timeline-reducer.ts` | NEW — pure reducer |
| `apps/expo/src/features/sessions/session-types.ts` | EDIT — add `streamingByAgent` to controller state |
| `apps/expo/src/features/sessions/session-detail-controller.ts` | EDIT — replace `mergeMessage` with reducer |
| `apps/expo/src/features/sessions/components/SessionMessageRow.tsx` | EDIT — accept `isStreaming` prop |
| `apps/expo/src/features/sessions/screens/SessionDetailScreen.tsx` | EDIT — append streaming virtual rows |

### 4.2 Event types

```ts
export type TimelineEvent =
  | { kind: "messageCommitted"; message: SessionMessage }
  | { kind: "streamingDelta";
      agentId: string; messageId: string;
      messageKind: SessionMessage["kind"];
      deltaText: string; createdAt: string }
  | { kind: "streamingDone"; agentId: string; messageId: string };
```

### 4.3 Reducer state

```ts
type TimelineState = {
  messages: SessionMessage[];                              // committed, sorted by createdAt
  streamingByAgent: Map<string, StreamingBuffer>;          // agentId → in-flight
};
type StreamingBuffer = {
  messageId: string;
  text: string;
  kind: SessionMessage["kind"];
  startedAt: string;
};
```

### 4.4 Reduce rules

- `messageCommitted`:
  - If `messages[].some(m => m.messageId === ev.message.messageId)`: **longest-content-wins** (replace if `ev.message.content.length > existing.content.length`). Fixes current `mergeMessage` drop bug.
  - Else: insert sorted by `createdAt` then `messageId`.
  - Also: if `streamingByAgent` holds the same `messageId`, delete that entry (commit overrides any in-flight).
- `streamingDelta`:
  - `streamingByAgent.set(agentId, { messageId, text: prev.text + deltaText (or deltaText if new), kind: messageKind, startedAt: prev?.startedAt ?? createdAt })`.
  - Does **not** touch `messages`.
- `streamingDone`:
  - `streamingByAgent.delete(agentId)`. (The committed message arrives separately via `messageCommitted`.)

### 4.5 Controller wiring

`session-detail-controller.ts`:

- Replace `mergeMessage` with `reduce(state, event)`.
- Inbound MQTT messages: decode → if delta-shaped, emit `streamingDelta`; else `messageCommitted`. (Proto shape determines this — daemon today emits full messages; the delta branch is dead code until daemon adds delta support, but the reducer is ready.)
- Even without daemon delta support, the **longest-content-wins** fix is live and resolves the immediate dropped-update bug.

### 4.6 Rendering

`SessionDetailScreen`:

```ts
const rows = [
  ...state.messages,
  ...Array.from(state.streamingByAgent.values()).map((buf) => toVirtualRow(buf)),
];
```

Virtual row: `messageId: buf.messageId`, `senderActorId: agentId` (resolved to actor display via existing actor map), `content: buf.text`, `kind: buf.kind`, plus `isStreaming: true`.

`SessionMessageRow` renders `isStreaming: true` with a subtle pulsing cursor (`Animated.Value` opacity loop) at the tail of the text.

Sort order: streaming rows sort to the end (their `startedAt` is recent and they get replaced atomically when committed arrives).

### 4.7 Tests

- `timeline-reducer.test.ts`:
  - same `messageId` recommit with longer content → replaces.
  - same `messageId` recommit with shorter/equal content → ignored.
  - two `streamingDelta` events for two different `agentId` → both kept independently.
  - `streamingDelta` → `streamingDone` → buffer cleared.
  - `messageCommitted` arrives before `streamingDone` → buffer cleared on commit.
  - `messageCommitted` arrives out of order (createdAt earlier than existing) → inserted at correct position.

## 5. Section C — ShortcutWebView

### 5.1 Files

| File | Change |
|---|---|
| `apps/expo/package.json` | EDIT — add `react-native-webview` |
| `apps/expo/app/(app)/shortcut-web.tsx` | NEW — modal route |
| `apps/expo/app/(app)/_layout.tsx` | EDIT — register screen with `presentation: 'fullScreenModal'` |
| `apps/expo/src/features/shortcuts/ShortcutWebScreen.tsx` | NEW — chrome + WebView |
| `apps/expo/src/features/shortcuts/ShortcutsDrawer.tsx` | EDIT — `openShortcutTarget` routes URL/external types to webview |

### 5.2 Chrome layout

```
┌────────────────────────────────────────────────┐
│ [×]  Title                  [<] [>] [⟳] [↗]   │
│      host.com                                  │
├────────────────────────────────────────────────┤
│ ▬▬▬▬ (loading bar 1.5pt cinnabar, 1.1s loop)  │
├────────────────────────────────────────────────┤
│              <WebView fills rest>              │
└────────────────────────────────────────────────┘
```

### 5.3 Chrome state

Driven off `react-native-webview`'s `onNavigationStateChange`:

```ts
const [navState, setNavState] = useState({
  canGoBack: false, canGoForward: false,
  loading: false, title: "", url: initialUrl,
});
```

- Title falls back to `initialTitle` (prop from shortcut row) when `navState.title` is empty.
- Host extracted via `new URL(navState.url).host`.
- Disabled chrome buttons render at 0.5 opacity, same as iOS.

### 5.4 Action wiring

- `back` / `forward` / `reload` → `webviewRef.current?.goBack() / goForward() / reload()`.
- `share` → `Share.share({ url: navState.url, message: navState.title || navState.url })`.
- `close` → `router.back()`.

### 5.5 WebView config

```ts
<WebView
  ref={webviewRef}
  source={{ uri: initialUrl }}
  onNavigationStateChange={setNavState}
  allowsInlineMediaPlayback
  allowsBackForwardNavigationGestures
  mediaPlaybackRequiresUserAction={false}
  startInLoadingState
  decelerationRate="normal"
/>
```

### 5.6 Loading bar animation

`Animated.timing` with `useNativeDriver: true`, loops linearly 0 → 1 over 1100ms (`Easing.linear`, `Animated.loop(... , { iterations: -1 })`). Visible while `navState.loading === true`. Cinnabar fill, 1.5pt tall, 80pt wide, translates inside a parent View of full chrome width.

### 5.7 Drawer integration

`ShortcutsDrawer.tsx:374` `openShortcutTarget` — case branch:

```ts
if (shortcut.nodeType === "url" || shortcut.nodeType === "external") {
  router.push({
    pathname: "/(app)/shortcut-web",
    params: { url: shortcut.target, title: shortcut.label },
  });
  return;
}
// session case unchanged
```

### 5.8 Tests

- `openShortcutTarget` unit test: URL type → `router.push('/(app)/shortcut-web', ...)`, session type → existing session route.
- Manual verify (smoke): open a URL shortcut, exercise back/forward/reload/share/close.

## 6. Section D — ConnectedAgentsStore + Real-time Runtime

### 6.1 Files

| File | Change |
|---|---|
| `apps/expo/src/features/actors/connected-agent-types.ts` | NEW — `ConnectedAgent`, `RuntimeInfo`, `AgentAuthorizedHuman` |
| `apps/expo/src/features/actors/agent-access-api.ts` | NEW — Supabase RPC wrappers |
| `apps/expo/src/features/actors/connected-agents-store.ts` | NEW — state store |
| `apps/expo/src/features/actors/runtime-state-subscriber.ts` | NEW — MQTT subscription + decoding |
| `apps/expo/src/lib/db/migrations.ts` | EDIT — add `connected_agents` cache table |
| `apps/expo/app/_layout.tsx` | EDIT — create store when team activates; dispose on signout/switch |

### 6.2 Types

```ts
export type ConnectedAgent = {
  agentId: string;
  displayName: string;
  agentKind: string;          // "claude" | "opencode" | "codex" | ...
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
```

### 6.3 Supabase API

```ts
export function createAgentAccessApi(client: SupabaseClient): {
  listConnectedAgents: (teamId: string) => Promise<ConnectedAgent[]>;
  shareAgentToTeam: (agentId: string) => Promise<void>;
  makeAgentPersonal: (agentId: string) => Promise<void>;
  listAuthorizedHumans: (agentId: string) => Promise<AgentAuthorizedHuman[]>;
  canManageAuthorizedHumans: (agentId: string) => Promise<boolean>;
  grantAuthorizedHuman: (agentId: string, memberId: string, permissionLevel: string) => Promise<void>;
};
```

RPC names mirror iOS `SupabaseAgentAccessRepository` (the table/RPC contract is already shared with the backend).

### 6.4 Runtime subscriber (`runtime-state-subscriber.ts`)

```ts
export function createRuntimeStateSubscriber(deps: {
  mqtt: TeamMqttClient;
  teamId: string;
  onRuntimeInfo: (deviceId: string, runtimeId: string, info: RuntimeInfo) => void;
}): {
  watchDevice: (deviceId: string) => void;    // subscribe wildcard for this device
  unwatchDevice: (deviceId: string) => void;
  dispose: () => void;
};
```

Subscription topic: `amux/{teamId}/device/{deviceId}/runtime/+/state` (matches `MQTTTopics.runtimeStateWildcard` in iOS).

On each retained `Amux_RuntimeInfo` payload:
1. Parse `runtimeId` from the topic's `+` segment.
2. `decodeRuntimeInfo(payload)` via `@teamclaw/app/proto/amux_pb`.
3. Call `onRuntimeInfo(deviceId, runtimeId, info)`.

Internal map tracks active subscriptions so `unwatchDevice` reliably unsubscribes.

### 6.5 Store (`connected-agents-store.ts`)

```ts
export type ConnectedAgentsStoreState = {
  agents: ConnectedAgent[];
  runtimeInfoByAgentId: Map<string, RuntimeInfo>;
  isLoading: boolean;
  errorMessage: string | null;
};

export function createConnectedAgentsStore(deps: {
  teamId: string;
  api: ReturnType<typeof createAgentAccessApi>;
  mqtt: TeamMqttClient;
  cache?: ConnectedAgentsCache;  // sqlite-backed, optional
}): {
  subscribe: (listener: () => void) => () => void;
  getState: () => ConnectedAgentsStoreState;
  reload: () => Promise<void>;
  shareToTeam: (agentId: string) => Promise<boolean>;
  makePersonal: (agentId: string) => Promise<boolean>;
  dispose: () => Promise<void>;
};
```

Lifecycle:
1. **Construct** — load cache from sqlite, paint instantly.
2. **`reload()`** — `api.listConnectedAgents(teamId)` → set `agents` → write to cache.
3. **Watch devices** — for each agent with non-null `deviceId`, `runtimeStateSubscriber.watchDevice(deviceId)`. Updates `runtimeInfoByAgentId` + bumps `lastActiveAt` on the matching agent.
4. **`dispose()`** — unwatch all devices, clear listeners.

When `reload()` returns a different set of devices than was previously watched, the diff is applied (unwatch removed, watch added).

### 6.6 SQLite cache (optional, for instant cold-start paint)

```sql
CREATE TABLE connected_agents (
  team_id        TEXT NOT NULL,
  agent_id       TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  agent_kind     TEXT NOT NULL,
  permission_level TEXT NOT NULL,
  visibility     TEXT NOT NULL,
  is_owner       INTEGER NOT NULL,    -- bool 0/1
  device_id      TEXT,
  last_active_at INTEGER,
  current_model  TEXT,
  status         INTEGER,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (team_id, agent_id)
);
```

DAO: `loadCache(teamId)` / `saveCache(teamId, agents)` / `clearCache(teamId)`.

### 6.7 Online derivation

```ts
export function isAgentOnline(agent: ConnectedAgent): boolean {
  if (!agent.lastActiveAt) return false;
  const t = Date.parse(agent.lastActiveAt);
  return Number.isFinite(t) && Date.now() - t < 120_000;
}
```

Matches iOS `ConnectedAgent.isOnline:31` exactly (120s window).

### 6.8 Root wiring (`app/_layout.tsx`)

When the onboarding state transitions to `ready` with a `currentTeam`:

```ts
const mqtt = createTeamMqttClient({ url, username: actorId, password: token, clientId });
const store = createConnectedAgentsStore({ teamId, api: agentAccessApi, mqtt, cache });
await store.reload();
```

Dispose on sign-out, team-switch, and on unmount.

Existing `session-detail-controller` switches from its own MQTT connect/disconnect to consuming this team-scoped `TeamMqttClient` (small refactor; subscribe/publish surface is compatible).

### 6.9 Tests

- `connected-agents-store.test.ts`:
  - `reload` populates agents and writes cache.
  - subscribing to runtime info: simulated proto payload bumps `lastActiveAt` and sets `runtimeInfoByAgentId`.
  - device watch diff: agent removed → unwatchDevice called; new agent → watchDevice.
  - `dispose` clears all subscriptions.
- `runtime-state-subscriber.test.ts`: topic parsing extracts `runtimeId` correctly across edge cases (single segment, multi-segment, malformed).
- `is-agent-online.test.ts`: boundary at exactly 120s, undefined, future date, malformed string.

## 7. Implementation order

1. **Infrastructure** — `sqlite.ts`, `migrations.ts`, `team-mqtt.ts`. Run schema migration. No user-visible change yet.
2. **Section A (Outbox)** — validates the sqlite path end-to-end. Users gain durable retry immediately.
3. **Section D (ConnectedAgentsStore)** — validates the team-mqtt fanout. ActorsListScreen starts showing live online state + current model.
4. **Section B (Timeline reducer)** — replaces `mergeMessage`. Fixes the longest-content-wins bug live; per-agent buffers ready for daemon delta support.
5. **Section C (WebView)** — independent; landing it last is non-blocking. Shortcut URL/external nodes now open in-app with full chrome.

## 8. Dependencies & migrations

New npm deps:
- `expo-sqlite` (Sections A, D)
- `react-native-webview` (Section C)

Schema migrations: single initial migration v1 creates `outbox` + `connected_agents`. Versioned in `migrations.ts`.

No app.json plugin entries required (both libs work out-of-box in Expo SDK 53).

## 9. Risk register

| Risk | Mitigation |
|---|---|
| Daemon doesn't emit streaming deltas today → per-agent buffer is dormant | The bugfix half (longest-content-wins on `messageCommitted`) is live regardless. Buffer activates when daemon ships delta. |
| `Amux_RuntimeInfo` proto field changes upstream | Type adapter in `runtime-state-subscriber.ts` decouples wire format from store. |
| MQTT wildcard subscribe permission denied on broker | Surface as `errorMessage` on store; agents still render from Supabase cache with stale lastActiveAt. |
| SQLite migration failure on existing user | Migrations are append-only; failure path logs and continues (DAO ops degrade to in-memory fallback for the session). |
| react-native-webview Android crash on edge cases (PDFs, large media) | Add `originWhitelist={['*']}` and wrap render in `<ErrorBoundary>` with "Open in browser" fallback. |
| Two MQTT clients (session + team) competing for client_id slot on broker | Single shared `TeamMqttClient`. session-detail-controller refactor to consume it removes the conflict. |

## 10. Non-goals (explicit)

- Streaming delta wire format design — daemon-side; this spec only consumes whatever shape it eventually emits.
- ActorsListScreen redesign — store consumers can be wired in a follow-up; today's screen continues to work off `actor-api.ts`.
- ShortcutWebView favicon / share-to-chat / "save for later" — chrome parity is iOS-equivalent; further features are out of scope.
- Push presence heartbeat (separate iOS feature, deferred).
