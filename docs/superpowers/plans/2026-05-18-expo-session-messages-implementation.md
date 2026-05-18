# Expo Session Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `apps/expo` session detail from a metadata shell into a team-scoped, read-only message view backed by the live `messages` table.

**Architecture:** Keep Expo Router route files thin and continue to use the existing authenticated `/(app)/sessions/[sessionId]` route. Add message-specific types and Supabase reads inside the existing sessions feature, then upgrade the detail route to aggregate `getSession` and `listMessages` into one honest detail state machine covering `loading`, `not-found`, `error`, `empty`, and `ready`.

**Tech Stack:** Expo Router, React Native, TypeScript, `@supabase/supabase-js`, Vitest

---

## File Structure

### Route files

- Modify: `apps/expo/app/(app)/sessions/[sessionId].tsx`
  - keep the onboarding/team guard, load session summary + messages together, and map backend results into route-level detail states

### Session feature files

- Modify: `apps/expo/src/features/sessions/session-types.ts`
  - add the read-only message type used by this phase
- Modify: `apps/expo/src/features/sessions/session-api.ts`
  - add `listMessages(teamId, sessionId)` and the backend mapping helpers for message rows
- Create: `apps/expo/src/features/sessions/components/SessionMessageRow.tsx`
  - render a single read-only message row with the current mobile visual language
- Modify: `apps/expo/src/features/sessions/screens/SessionDetailScreen.tsx`
  - replace the metadata-only body with `loading`, `empty`, and `ready` timeline states while keeping header metadata visible

### Tests

- Modify: `apps/expo/src/test/session-api.test.ts`
  - add message mapping and `listMessages` coverage
- Create: `apps/expo/src/test/session-detail-state.test.ts`
  - cover detail-state aggregation for `ready`, `empty`, `not-found`, and `error`

### Documentation

- Modify: `apps/expo/README.md`
  - update the current scope to mention read-only message history and clarify that composer/send is still not migrated

## Task 1: Define message types and API-mapping tests

**Files:**
- Modify: `apps/expo/src/features/sessions/session-types.ts`
- Modify: `apps/expo/src/test/session-api.test.ts`

- [ ] **Step 1: Write the failing message-mapping tests**

```ts
// apps/expo/src/test/session-api.test.ts
it("maps nullable message fields into the mobile message shape", async () => {
  const { mapMessageRecord } = await import("../features/sessions/session-types");

  expect(
    mapMessageRecord({
      content: null,
      created_at: "2026-05-18T08:15:00.000Z",
      kind: null,
      model: null,
      sender_actor_id: null,
      session_id: "session-1",
      team_id: "team-1",
      message_id: "message-1",
    }),
  ).toEqual({
    content: "",
    createdAt: "2026-05-18T08:15:00.000Z",
    kind: "text",
    messageId: "message-1",
    model: "",
    senderActorId: "",
    sessionId: "session-1",
    teamId: "team-1",
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @teamclaw/expo exec vitest run src/test/session-api.test.ts`

Expected: FAIL with `mapMessageRecord is not a function` or equivalent missing-export error.

- [ ] **Step 3: Add the message types and mapper**

```ts
// apps/expo/src/features/sessions/session-types.ts
export interface SessionMessage {
  messageId: string;
  sessionId: string;
  teamId: string;
  senderActorId: string;
  kind: string;
  content: string;
  model: string;
  createdAt: string;
}

export interface MessageRecord {
  message_id: string | null;
  session_id: string | null;
  team_id: string | null;
  sender_actor_id: string | null;
  kind: string | null;
  content: string | null;
  model: string | null;
  created_at: string | null;
}

export function mapMessageRecord(record: MessageRecord): SessionMessage {
  return {
    messageId: record.message_id ?? "",
    sessionId: record.session_id ?? "",
    teamId: record.team_id ?? "",
    senderActorId: record.sender_actor_id ?? "",
    kind: record.kind ?? "text",
    content: record.content ?? "",
    model: record.model ?? "",
    createdAt: record.created_at ?? "",
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @teamclaw/expo exec vitest run src/test/session-api.test.ts`

Expected: PASS with the new mapping assertion green.

- [ ] **Step 5: Commit**

```bash
git add apps/expo/src/features/sessions/session-types.ts apps/expo/src/test/session-api.test.ts
git commit -m "feat: add expo session message types"
```

## Task 2: Add real message reads to the sessions API

**Files:**
- Modify: `apps/expo/src/features/sessions/session-api.ts`
- Modify: `apps/expo/src/test/session-api.test.ts`

- [ ] **Step 1: Write the failing `listMessages` API test**

```ts
// apps/expo/src/test/session-api.test.ts
it("listMessages returns team-scoped session messages sorted oldest first", async () => {
  const { createSessionsApi } = await import("../features/sessions/session-api");

  const messagesQuery = createQueryMock(
    Promise.resolve({
      data: [
        {
          message_id: "message-2",
          session_id: "session-1",
          team_id: "team-1",
          sender_actor_id: "actor-2",
          kind: "assistant",
          content: "Second",
          model: "gpt-5",
          created_at: "2026-05-18T08:05:00.000Z",
        },
        {
          message_id: "message-1",
          session_id: "session-1",
          team_id: "team-1",
          sender_actor_id: "actor-1",
          kind: "text",
          content: "First",
          model: "",
          created_at: "2026-05-18T08:00:00.000Z",
        },
      ],
      error: null,
    }),
  );

  const from = vi.fn((table: string) => {
    if (table === "messages") return messagesQuery;
    throw new Error(`unexpected table: ${table}`);
  });

  const api = createSessionsApi({ from } as any);

  await expect(api.listMessages("team-1", "session-1")).resolves.toEqual([
    expect.objectContaining({ messageId: "message-1" }),
    expect.objectContaining({ messageId: "message-2" }),
  ]);
  expect(messagesQuery.eq).toHaveBeenNthCalledWith(1, "team_id", "team-1");
  expect(messagesQuery.eq).toHaveBeenNthCalledWith(2, "session_id", "session-1");
  expect(messagesQuery.order).toHaveBeenCalledWith("created_at", { ascending: true });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @teamclaw/expo exec vitest run src/test/session-api.test.ts`

Expected: FAIL with `api.listMessages is not a function`.

- [ ] **Step 3: Implement the minimal API support**

```ts
// apps/expo/src/features/sessions/session-api.ts
const MESSAGE_COLUMNS =
  "message_id:id, session_id, team_id, sender_actor_id, kind, content, model, created_at";

export function createSessionsApi(client: SessionsClient) {
  return {
    // existing listSessions/getSession stay unchanged
    async listMessages(teamId: string, sessionId: string): Promise<SessionMessage[]> {
      const result = await client
        .from("messages")
        .select(MESSAGE_COLUMNS)
        .eq("team_id", teamId)
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true });
      throwIfError(result.error);

      const rows = (result.data ?? []) as MessageRecord[];
      return rows
        .map((row) => mapMessageRecord(row))
        .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @teamclaw/expo exec vitest run src/test/session-api.test.ts`

Expected: PASS with the new `listMessages` assertion green.

- [ ] **Step 5: Commit**

```bash
git add apps/expo/src/features/sessions/session-api.ts apps/expo/src/test/session-api.test.ts
git commit -m "feat: add expo session message reads"
```

## Task 3: Add a reusable read-only message row

**Files:**
- Create: `apps/expo/src/features/sessions/components/SessionMessageRow.tsx`

- [ ] **Step 1: Write the message-row component**

```tsx
// apps/expo/src/features/sessions/components/SessionMessageRow.tsx
import { StyleSheet, Text, View } from "react-native";

import type { SessionMessage } from "../session-types";
import { colors, radii, spacing, typography } from "../../../ui/theme";

type SessionMessageRowProps = {
  isOwnMessage?: boolean;
  message: SessionMessage;
};

function normalizeBody(message: SessionMessage): string {
  const body = message.content.trim();

  if (!body) {
    return "内容为空";
  }

  if (message.kind !== "text" && message.kind !== "assistant") {
    return "暂未在移动端展开此消息类型";
  }

  return body;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "时间未知";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function SessionMessageRow({ isOwnMessage = false, message }: SessionMessageRowProps) {
  return (
    <View style={[styles.row, isOwnMessage ? styles.rowOwn : styles.rowOther]}>
      <View style={[styles.surface, isOwnMessage ? styles.surfaceOwn : styles.surfaceOther]}>
        <Text style={styles.body}>{normalizeBody(message)}</Text>
        <Text style={styles.meta}>{formatTimestamp(message.createdAt)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    color: colors.foreground,
    ...typography.body,
  },
  meta: {
    color: colors.faint,
    ...typography.monoMeta,
  },
  row: {
    width: "100%",
  },
  rowOther: {
    alignItems: "flex-start",
  },
  rowOwn: {
    alignItems: "flex-end",
  },
  surface: {
    gap: spacing.sm,
    maxWidth: "82%",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  surfaceOther: {
    backgroundColor: colors.paper,
    borderColor: colors.border,
    borderRadius: radii.card,
    borderWidth: 1,
  },
  surfaceOwn: {
    backgroundColor: colors.selected,
    borderRadius: radii.card,
  },
});
```

- [ ] **Step 2: Run typecheck to verify the new component integrates**

Run: `pnpm --filter @teamclaw/expo exec tsc --noEmit`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/expo/src/features/sessions/components/SessionMessageRow.tsx
git commit -m "feat: add expo session message row"
```

## Task 4: Add detail-state tests for message-aware route loading

**Files:**
- Create: `apps/expo/src/test/session-detail-state.test.ts`

- [ ] **Step 1: Write the failing detail-state tests**

```ts
// apps/expo/src/test/session-detail-state.test.ts
import { describe, expect, it } from "vitest";

import type { SessionMessage, SessionSummary } from "../features/sessions/session-types";

type DetailState =
  | { status: "loading"; session: null; messages: []; errorMessage: null }
  | { status: "not-found"; session: null; messages: []; errorMessage: null }
  | { status: "error"; session: null; messages: []; errorMessage: string }
  | { status: "empty"; session: SessionSummary; messages: []; errorMessage: null }
  | { status: "ready"; session: SessionSummary; messages: SessionMessage[]; errorMessage: null };

describe("buildSessionDetailState", () => {
  it("returns empty when the session exists but there are no messages", async () => {
    const { buildSessionDetailState } = await import("../features/sessions/session-types");
    const session = { sessionId: "session-1" } as SessionSummary;

    expect(buildSessionDetailState(session, [])).toEqual({
      status: "empty",
      session,
      messages: [],
      errorMessage: null,
    } satisfies DetailState);
  });

  it("returns ready when the session exists and messages are present", async () => {
    const { buildSessionDetailState } = await import("../features/sessions/session-types");
    const session = { sessionId: "session-1" } as SessionSummary;
    const messages = [{ messageId: "message-1" }] as SessionMessage[];

    expect(buildSessionDetailState(session, messages)).toEqual({
      status: "ready",
      session,
      messages,
      errorMessage: null,
    } satisfies DetailState);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @teamclaw/expo exec vitest run src/test/session-detail-state.test.ts`

Expected: FAIL with `buildSessionDetailState is not a function`.

- [ ] **Step 3: Add the detail-state helper**

```ts
// apps/expo/src/features/sessions/session-types.ts
export type SessionDetailState =
  | { status: "loading"; session: null; messages: []; errorMessage: null }
  | { status: "not-found"; session: null; messages: []; errorMessage: null }
  | { status: "error"; session: null; messages: []; errorMessage: string }
  | { status: "empty"; session: SessionSummary; messages: []; errorMessage: null }
  | { status: "ready"; session: SessionSummary; messages: SessionMessage[]; errorMessage: null };

export function buildSessionDetailState(
  session: SessionSummary,
  messages: SessionMessage[],
): Extract<SessionDetailState, { status: "empty" | "ready" }> {
  if (messages.length === 0) {
    return {
      status: "empty",
      session,
      messages: [],
      errorMessage: null,
    };
  }

  return {
    status: "ready",
    session,
    messages,
    errorMessage: null,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @teamclaw/expo exec vitest run src/test/session-detail-state.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/expo/src/features/sessions/session-types.ts apps/expo/src/test/session-detail-state.test.ts
git commit -m "feat: add expo session detail state helper"
```

## Task 5: Upgrade the detail screen to render loading, empty, and ready timeline states

**Files:**
- Modify: `apps/expo/src/features/sessions/screens/SessionDetailScreen.tsx`
- Create: `apps/expo/src/features/sessions/components/SessionMessageRow.tsx`

- [ ] **Step 1: Replace the metadata-only body with state-aware detail rendering**

```tsx
// apps/expo/src/features/sessions/screens/SessionDetailScreen.tsx
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { SessionMessageRow } from "../components/SessionMessageRow";
import type { SessionDetailState } from "../session-types";
import { PrimaryButton } from "../../../ui/button";
import { AppCard } from "../../../ui/card";
import { colors, spacing, typography } from "../../../ui/theme";

type SessionDetailScreenProps = {
  onBack: () => void;
  ownActorId?: string;
  state: Extract<SessionDetailState, { status: "empty" | "ready" }>;
};

export function SessionDetailScreen({ onBack, ownActorId, state }: SessionDetailScreenProps) {
  const { session } = state;

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>{session.title.trim() || "未命名会话"}</Text>
        <Text style={styles.meta}>
          {session.participantCount} 位参与者 · {session.sessionId}
        </Text>
      </View>

      {state.status === "empty" ? (
        <AppCard elevated style={styles.card}>
          <Text style={styles.cardTitle}>还没有消息</Text>
          <Text style={styles.body}>这个会话已经创建，但目前还没有任何聊天记录。</Text>
          <PrimaryButton fullWidth={false} label="返回会话列表" onPress={onBack} />
        </AppCard>
      ) : (
        <View style={styles.timeline}>
          {state.messages.map((message) => (
            <SessionMessageRow
              isOwnMessage={ownActorId ? message.senderActorId === ownActorId : false}
              key={message.messageId}
              message={message}
            />
          ))}
        </View>
      )}
    </ScrollView>
  );
}
```

- [ ] **Step 2: Run Expo tests to verify screen changes do not regress**

Run: `pnpm expo:test`

Expected: PASS with all existing tests still green.

- [ ] **Step 3: Commit**

```bash
git add apps/expo/src/features/sessions/screens/SessionDetailScreen.tsx apps/expo/src/features/sessions/components/SessionMessageRow.tsx
git commit -m "feat: render expo session message timeline"
```

## Task 6: Wire message reads into the session detail route

**Files:**
- Modify: `apps/expo/app/(app)/sessions/[sessionId].tsx`
- Modify: `apps/expo/src/features/sessions/session-types.ts`
- Create: `apps/expo/src/test/session-detail-state.test.ts`

- [ ] **Step 1: Update the route to load session summary and messages together**

```tsx
// apps/expo/app/(app)/sessions/[sessionId].tsx
const initialState: SessionDetailState = {
  status: "loading",
  session: null,
  messages: [],
  errorMessage: null,
};

useEffect(() => {
  if (state.route !== "ready" || !sessionId || currentTeam === null) {
    return;
  }

  let isCancelled = false;

  const loadSession = async () => {
    setDetailState(initialState);

    try {
      const api = createSessionsApi(supabase);
      const [session, messages] = await Promise.all([
        api.getSession(currentTeam.id, sessionId),
        api.listMessages(currentTeam.id, sessionId),
      ]);

      if (isCancelled) {
        return;
      }

      if (!session) {
        setDetailState({
          status: "not-found",
          session: null,
          messages: [],
          errorMessage: null,
        });
        return;
      }

      setDetailState(buildSessionDetailState(session, messages));
    } catch (error) {
      if (isCancelled) {
        return;
      }

      setDetailState({
        status: "error",
        session: null,
        messages: [],
        errorMessage: error instanceof Error ? error.message : "加载会话失败。",
      });
    }
  };

  void loadSession();
  return () => {
    isCancelled = true;
  };
}, [currentTeam, sessionId, state.route]);
```

- [ ] **Step 2: Pass the loaded state into the upgraded detail screen**

```tsx
// apps/expo/app/(app)/sessions/[sessionId].tsx
{detailState.status === "empty" || detailState.status === "ready" ? (
  <SessionDetailScreen
    onBack={handleBackToList}
    ownActorId={state.currentMemberActorId ?? undefined}
    state={detailState}
  />
) : null}
```

- [ ] **Step 3: Run focused verification**

Run:

```sh
pnpm --filter @teamclaw/expo exec vitest run src/test/session-api.test.ts src/test/session-detail-state.test.ts
pnpm --filter @teamclaw/expo exec tsc --noEmit
```

Expected:

- both targeted Vitest files pass
- TypeScript exits cleanly

- [ ] **Step 4: Commit**

```bash
git add apps/expo/app/\(app\)/sessions/\[sessionId\].tsx apps/expo/src/features/sessions/session-types.ts apps/expo/src/test/session-detail-state.test.ts
git commit -m "feat: load expo session messages in detail route"
```

## Task 7: Update docs and run final verification

**Files:**
- Modify: `apps/expo/README.md`

- [ ] **Step 1: Update the README scope**

```md
## Current scope

This package now covers:

- onboarding and auth routing
- authenticated sessions landing route
- real session list loading
- session detail metadata and read-only message history
- placeholder new-session action

Not yet migrated:

- session creation flow
- chat composer and send flow
- realtime updates
- tool-call-specific message rendering
```

- [ ] **Step 2: Run the final verification commands**

Run:

```sh
pnpm expo:test
pnpm --filter @teamclaw/expo exec tsc --noEmit
pnpm --filter @teamclaw/expo exec node -e "console.log('session-messages-plan-verification')"
```

Expected:

- `pnpm expo:test` passes
- `tsc --noEmit` passes
- the node command prints `session-messages-plan-verification`

- [ ] **Step 3: Manual verification checklist**

Run this flow with valid Supabase env vars:

```text
1. Start Expo with pnpm expo:dev -- --clear
2. Sign in through the existing onboarding flow
3. Open /(app)/sessions and select a session with messages
4. Confirm the detail page shows chronological read-only history
5. Open a session with no messages and confirm the explicit empty state
6. Confirm there is still no composer or send action
```

- [ ] **Step 4: Commit**

```bash
git add apps/expo/README.md
git commit -m "docs: update expo readme for session messages"
```

## Self-Review

- Spec coverage: route shape, live `messages` read, empty/not-found/error states, read-only timeline, and final verification are all covered by Tasks 2, 4, 5, 6, and 7.
- Placeholder scan: no `TODO`, `TBD`, or implicit “handle later” steps remain; each task contains exact files, commands, and code snippets.
- Type consistency: `SessionMessage`, `listMessages(teamId, sessionId)`, `SessionDetailState`, and `buildSessionDetailState` are introduced before later tasks consume them.
