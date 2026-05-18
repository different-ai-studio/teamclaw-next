# Expo Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `apps/expo` from onboarding-only flow into an authenticated Sessions experience with a real session list, a minimal session detail shell, and an iOS-aligned placeholder `New Session` action.

**Architecture:** Keep Expo Router route files thin and move session behavior into a dedicated `src/features/sessions/` slice. Reuse the existing onboarding/auth context to gate access to the authenticated stack, add a small sessions API for Supabase reads, and use a focused controller for list loading and refresh behavior while keeping detail loading route-local.

**Tech Stack:** Expo Router, React Native, TypeScript, `@supabase/supabase-js`, Vitest

---

## File Structure

### Route files

- Modify: `apps/expo/app/(app)/_layout.tsx`
  - switch the authenticated area from a passive slot wrapper to a stack that can host the sessions routes
- Modify: `apps/expo/app/(app)/home.tsx`
  - turn the old authenticated placeholder into a compatibility redirect to the sessions route
- Create: `apps/expo/app/(app)/sessions/index.tsx`
  - route wrapper for the sessions list screen
- Create: `apps/expo/app/(app)/sessions/[sessionId].tsx`
  - route wrapper for the session detail screen
- Modify: `apps/expo/app/_layout.tsx`
  - update the ready-state destination from `/(app)/home` to `/(app)/sessions`

### Session feature files

- Create: `apps/expo/src/features/sessions/session-types.ts`
  - session shapes, grouped list types, and controller state types
- Create: `apps/expo/src/features/sessions/session-api.ts`
  - Supabase reads and record mapping for list and detail
- Create: `apps/expo/src/features/sessions/session-controller.ts`
  - list loading and refresh controller
- Create: `apps/expo/src/features/sessions/components/SessionRow.tsx`
  - reusable row rendering aligned with the iOS Sessions tab
- Create: `apps/expo/src/features/sessions/screens/SessionsListScreen.tsx`
  - loading, empty, error, and loaded list UI
- Create: `apps/expo/src/features/sessions/screens/SessionDetailScreen.tsx`
  - metadata shell for a single session

### Tests

- Create: `apps/expo/src/test/session-api.test.ts`
  - backend mapping coverage for `listSessions` and `getSession`
- Create: `apps/expo/src/test/session-controller.test.ts`
  - controller coverage for loading, empty, error, and refresh states

### Documentation

- Modify: `apps/expo/README.md`
  - update the current scope to mention the Sessions route and the remaining chat migration gap

## Task 1: Define the session domain types and API contracts

**Files:**
- Create: `apps/expo/src/features/sessions/session-types.ts`
- Create: `apps/expo/src/test/session-api.test.ts`

- [ ] **Step 1: Write the failing API-mapping tests**

```ts
// apps/expo/src/test/session-api.test.ts
import { describe, expect, it } from "vitest";

import { groupSessionsByRecency, mapSessionRecord } from "../features/sessions/session-types";

describe("mapSessionRecord", () => {
  it("maps nullable backend fields into the mobile session shape", () => {
    const session = mapSessionRecord({
      created_at: "2026-05-18T09:00:00.000Z",
      created_by: "actor-1",
      id: "session-1",
      last_message_at: null,
      last_message_preview: null,
      participant_count: 2,
      summary: null,
      team_id: "team-1",
      title: "",
    });

    expect(session).toEqual({
      createdAt: "2026-05-18T09:00:00.000Z",
      createdBy: "actor-1",
      lastMessageAt: null,
      lastMessagePreview: "",
      participantCount: 2,
      sessionId: "session-1",
      summary: "",
      teamId: "team-1",
      title: "",
    });
  });
});

describe("groupSessionsByRecency", () => {
  it("sorts by lastMessageAt before createdAt and groups into Today and Earlier", () => {
    const groups = groupSessionsByRecency(
      [
        {
          createdAt: "2026-05-16T09:00:00.000Z",
          createdBy: "actor-1",
          lastMessageAt: "2026-05-16T10:00:00.000Z",
          lastMessagePreview: "older update",
          participantCount: 1,
          sessionId: "older",
          summary: "",
          teamId: "team-1",
          title: "Older",
        },
        {
          createdAt: "2026-05-18T08:00:00.000Z",
          createdBy: "actor-2",
          lastMessageAt: null,
          lastMessagePreview: "today preview",
          participantCount: 3,
          sessionId: "today",
          summary: "",
          teamId: "team-1",
          title: "Today",
        },
      ],
      new Date("2026-05-18T12:00:00.000Z"),
    );

    expect(groups).toEqual([
      {
        id: "today",
        items: [
          expect.objectContaining({
            sessionId: "today",
          }),
        ],
        title: "Today",
      },
      {
        id: "earlier",
        items: [
          expect.objectContaining({
            sessionId: "older",
          }),
        ],
        title: "Earlier",
      },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @teamclaw/expo exec vitest run src/test/session-api.test.ts`

Expected: FAIL with a module resolution error for `session-types.ts`.

- [ ] **Step 3: Add the session domain types and helpers**

```ts
// apps/expo/src/features/sessions/session-types.ts
export type SessionSummary = {
  sessionId: string;
  teamId: string;
  title: string;
  summary: string;
  participantCount: number;
  lastMessagePreview: string;
  lastMessageAt: string | null;
  createdAt: string;
  createdBy: string;
};

export type SessionRecord = {
  id: string;
  team_id: string;
  title: string | null;
  summary: string | null;
  participant_count: number | null;
  last_message_preview: string | null;
  last_message_at: string | null;
  created_at: string;
  created_by: string | null;
};

export type SessionGroup = {
  id: string;
  title: "Today" | "Earlier";
  items: SessionSummary[];
};

export type SessionsListState =
  | { status: "idle"; groups: SessionGroup[]; sessions: SessionSummary[]; errorMessage: null; isRefreshing: false }
  | { status: "loading"; groups: SessionGroup[]; sessions: SessionSummary[]; errorMessage: null; isRefreshing: false }
  | { status: "empty"; groups: []; sessions: []; errorMessage: null; isRefreshing: false }
  | { status: "loaded"; groups: SessionGroup[]; sessions: SessionSummary[]; errorMessage: null; isRefreshing: boolean }
  | { status: "error"; groups: SessionGroup[]; sessions: SessionSummary[]; errorMessage: string; isRefreshing: false };

export function mapSessionRecord(record: SessionRecord): SessionSummary {
  return {
    createdAt: record.created_at,
    createdBy: record.created_by ?? "",
    lastMessageAt: record.last_message_at,
    lastMessagePreview: record.last_message_preview ?? "",
    participantCount: record.participant_count ?? 0,
    sessionId: record.id,
    summary: record.summary ?? "",
    teamId: record.team_id,
    title: record.title ?? "",
  };
}

function sortKey(session: SessionSummary): number {
  return Date.parse(session.lastMessageAt ?? session.createdAt);
}

export function groupSessionsByRecency(
  sessions: SessionSummary[],
  now: Date = new Date(),
): SessionGroup[] {
  const sorted = [...sessions].sort((left, right) => sortKey(right) - sortKey(left));
  const todayKey = now.toISOString().slice(0, 10);
  const today = sorted.filter((session) => (session.lastMessageAt ?? session.createdAt).slice(0, 10) === todayKey);
  const earlier = sorted.filter((session) => (session.lastMessageAt ?? session.createdAt).slice(0, 10) !== todayKey);

  const groups: SessionGroup[] = [];

  if (today.length > 0) {
    groups.push({ id: "today", title: "Today", items: today });
  }

  if (earlier.length > 0) {
    groups.push({ id: "earlier", title: "Earlier", items: earlier });
  }

  return groups;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @teamclaw/expo exec vitest run src/test/session-api.test.ts`

Expected: PASS with 2 passing tests.

- [ ] **Step 5: Commit**

```bash
git add apps/expo/src/features/sessions/session-types.ts apps/expo/src/test/session-api.test.ts
git commit -m "feat: add expo session domain types"
```

## Task 2: Implement the Supabase session API

**Files:**
- Create: `apps/expo/src/features/sessions/session-api.ts`
- Modify: `apps/expo/src/test/session-api.test.ts`

- [ ] **Step 1: Extend the failing test with API expectations**

```ts
// append to apps/expo/src/test/session-api.test.ts
import { createSessionApi } from "../features/sessions/session-api";

describe("createSessionApi", () => {
  it("lists sessions for a team and maps them into mobile rows", async () => {
    const select = vi.fn().mockResolvedValue({
      data: [
        {
          created_at: "2026-05-18T09:00:00.000Z",
          created_by: "actor-1",
          id: "session-1",
          last_message_at: "2026-05-18T10:00:00.000Z",
          last_message_preview: "Hello",
          participant_count: 2,
          summary: "Summary",
          team_id: "team-1",
          title: "Design review",
        },
      ],
      error: null,
    });

    const eq = vi.fn(() => ({ select }));
    const from = vi.fn(() => ({ eq }));
    const api = createSessionApi({ from } as never);

    await expect(api.listSessions("team-1")).resolves.toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        title: "Design review",
      }),
    ]);
    expect(from).toHaveBeenCalledWith("sessions");
  });

  it("returns null when a single session lookup has no row", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const eqSession = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq: eqSession }));
    const from = vi.fn(() => ({ select }));
    const api = createSessionApi({ from } as never);

    await expect(api.getSession("missing")).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @teamclaw/expo exec vitest run src/test/session-api.test.ts`

Expected: FAIL with a module resolution error for `session-api.ts`.

- [ ] **Step 3: Implement the API**

```ts
// apps/expo/src/features/sessions/session-api.ts
import type { SupabaseClient } from "@supabase/supabase-js";

import { mapSessionRecord, type SessionRecord, type SessionSummary } from "./session-types";

type SessionApi = {
  listSessions: (teamId: string) => Promise<SessionSummary[]>;
  getSession: (sessionId: string) => Promise<SessionSummary | null>;
};

const SESSION_SELECT =
  "id, team_id, title, summary, participant_count, last_message_preview, last_message_at, created_at, created_by";

export function createSessionApi(client: SupabaseClient): SessionApi {
  return {
    async listSessions(teamId) {
      const { data, error } = await client
        .from("sessions")
        .select(SESSION_SELECT)
        .eq("team_id", teamId);

      if (error) {
        throw new Error("Unable to load sessions");
      }

      return ((data ?? []) as SessionRecord[]).map(mapSessionRecord);
    },

    async getSession(sessionId) {
      const { data, error } = await client
        .from("sessions")
        .select(SESSION_SELECT)
        .eq("id", sessionId)
        .maybeSingle();

      if (error) {
        throw new Error("Unable to load session");
      }

      return data ? mapSessionRecord(data as SessionRecord) : null;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @teamclaw/expo exec vitest run src/test/session-api.test.ts`

Expected: PASS with 4 passing tests.

- [ ] **Step 5: Commit**

```bash
git add apps/expo/src/features/sessions/session-api.ts apps/expo/src/test/session-api.test.ts
git commit -m "feat: add expo sessions api"
```

## Task 3: Add the sessions list controller

**Files:**
- Create: `apps/expo/src/features/sessions/session-controller.ts`
- Create: `apps/expo/src/test/session-controller.test.ts`

- [ ] **Step 1: Write the failing controller tests**

```ts
// apps/expo/src/test/session-controller.test.ts
import { describe, expect, it, vi } from "vitest";

import { createSessionsController } from "../features/sessions/session-controller";

describe("createSessionsController", () => {
  it("loads sessions into the loaded state", async () => {
    const controller = createSessionsController({
      listSessions: vi.fn().mockResolvedValue([
        {
          createdAt: "2026-05-18T08:00:00.000Z",
          createdBy: "actor-1",
          lastMessageAt: "2026-05-18T09:00:00.000Z",
          lastMessagePreview: "Preview",
          participantCount: 2,
          sessionId: "session-1",
          summary: "",
          teamId: "team-1",
          title: "Review",
        },
      ]),
    });

    await controller.load("team-1");

    expect(controller.getState()).toMatchObject({
      status: "loaded",
      sessions: [expect.objectContaining({ sessionId: "session-1" })],
    });
  });

  it("moves to empty when the team has no sessions", async () => {
    const controller = createSessionsController({
      listSessions: vi.fn().mockResolvedValue([]),
    });

    await controller.load("team-1");

    expect(controller.getState()).toEqual({
      errorMessage: null,
      groups: [],
      isRefreshing: false,
      sessions: [],
      status: "empty",
    });
  });

  it("keeps existing rows visible while refresh is in flight", async () => {
    let resolveRefresh: ((value: unknown) => void) | undefined;
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce([
        {
          createdAt: "2026-05-18T08:00:00.000Z",
          createdBy: "actor-1",
          lastMessageAt: "2026-05-18T09:00:00.000Z",
          lastMessagePreview: "Preview",
          participantCount: 2,
          sessionId: "session-1",
          summary: "",
          teamId: "team-1",
          title: "Review",
        },
      ])
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );

    const controller = createSessionsController({ listSessions });
    await controller.load("team-1");

    const refreshPromise = controller.refresh();
    expect(controller.getState()).toMatchObject({
      isRefreshing: true,
      sessions: [expect.objectContaining({ sessionId: "session-1" })],
      status: "loaded",
    });

    resolveRefresh?.([]);
    await refreshPromise;
  });

  it("moves to error when loading fails", async () => {
    const controller = createSessionsController({
      listSessions: vi.fn().mockRejectedValue(new Error("boom")),
    });

    await expect(controller.load("team-1")).rejects.toThrow("boom");
    expect(controller.getState()).toMatchObject({
      errorMessage: "We couldn't load your sessions right now.",
      status: "error",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @teamclaw/expo exec vitest run src/test/session-controller.test.ts`

Expected: FAIL with a module resolution error for `session-controller.ts`.

- [ ] **Step 3: Implement the controller**

```ts
// apps/expo/src/features/sessions/session-controller.ts
import { groupSessionsByRecency, type SessionGroup, type SessionSummary, type SessionsListState } from "./session-types";

type SessionsApi = {
  listSessions: (teamId: string) => Promise<SessionSummary[]>;
};

type Listener = () => void;

const INITIAL_STATE: SessionsListState = {
  status: "idle",
  groups: [],
  sessions: [],
  errorMessage: null,
  isRefreshing: false,
};

export function createSessionsController(api: SessionsApi) {
  let state: SessionsListState = INITIAL_STATE;
  let teamId: string | null = null;
  const listeners = new Set<Listener>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const setState = (next: SessionsListState) => {
    state = next;
    notify();
  };

  const buildLoaded = (sessions: SessionSummary[], refreshing: boolean): SessionsListState => {
    const groups: SessionGroup[] = groupSessionsByRecency(sessions);

    if (sessions.length === 0) {
      return {
        status: "empty",
        groups: [],
        sessions: [],
        errorMessage: null,
        isRefreshing: false,
      };
    }

    return {
      status: "loaded",
      groups,
      sessions,
      errorMessage: null,
      isRefreshing: refreshing,
    };
  };

  const runLoad = async (refreshing: boolean) => {
    if (!teamId) {
      throw new Error("Sessions controller requires a team id before loading");
    }

    if (refreshing && state.status === "loaded") {
      setState({ ...state, isRefreshing: true });
    } else {
      setState({
        status: "loading",
        groups: state.groups,
        sessions: state.sessions,
        errorMessage: null,
        isRefreshing: false,
      });
    }

    try {
      const sessions = await api.listSessions(teamId);
      setState(buildLoaded(sessions, false));
    } catch (error) {
      setState({
        status: "error",
        groups: state.groups,
        sessions: state.sessions,
        errorMessage: "We couldn't load your sessions right now.",
        isRefreshing: false,
      });
      throw error;
    }
  };

  return {
    getState: () => state,
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async load(nextTeamId: string) {
      teamId = nextTeamId;
      await runLoad(false);
    },
    async refresh() {
      await runLoad(true);
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @teamclaw/expo exec vitest run src/test/session-controller.test.ts`

Expected: PASS with 4 passing tests.

- [ ] **Step 5: Commit**

```bash
git add apps/expo/src/features/sessions/session-controller.ts apps/expo/src/test/session-controller.test.ts
git commit -m "feat: add expo sessions controller"
```

## Task 4: Build the sessions list UI and wire it into the authenticated routes

**Files:**
- Create: `apps/expo/src/features/sessions/components/SessionRow.tsx`
- Create: `apps/expo/src/features/sessions/screens/SessionsListScreen.tsx`
- Create: `apps/expo/app/(app)/sessions/index.tsx`
- Modify: `apps/expo/app/(app)/_layout.tsx`
- Modify: `apps/expo/app/_layout.tsx`
- Modify: `apps/expo/app/(app)/home.tsx`

- [ ] **Step 1: Create the list row component**

```tsx
// apps/expo/src/features/sessions/components/SessionRow.tsx
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { SessionSummary } from "../session-types";
import { colors, spacing, typography } from "../../../ui/theme";

function formatTimestamp(value: string | null, createdAt: string): string {
  const source = value ?? createdAt;
  const date = new Date(source);
  const now = Date.now();
  const seconds = Math.floor((now - date.getTime()) / 1000);

  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function SessionRow({
  onPress,
  session,
}: {
  onPress: () => void;
  session: SessionSummary;
}) {
  const title = session.title.trim() || "Untitled Session";
  const preview = session.lastMessagePreview.trim();

  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      <View style={styles.header}>
        <Text numberOfLines={1} style={styles.title}>
          {title}
        </Text>
        <Text style={styles.time}>{formatTimestamp(session.lastMessageAt, session.createdAt)}</Text>
      </View>
      <Text numberOfLines={1} style={styles.preview}>
        {preview || "No messages yet"}
      </Text>
      <View style={styles.meta}>
        <Text style={styles.metaText}>{session.participantCount} participant{session.participantCount === 1 ? "" : "s"}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  meta: {
    marginTop: spacing.xs,
  },
  metaText: {
    color: colors.mutedForeground,
    ...typography.caption,
  },
  preview: {
    color: colors.ink2,
    marginTop: spacing.xs,
    ...typography.body,
  },
  row: {
    backgroundColor: colors.paper,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: spacing.sm,
    padding: spacing.lg,
  },
  rowPressed: {
    opacity: 0.82,
  },
  time: {
    color: colors.faint,
    ...typography.monoCaption,
  },
  title: {
    color: colors.foreground,
    flex: 1,
    ...typography.cardTitle,
  },
});
```

- [ ] **Step 2: Create the sessions list screen**

```tsx
// apps/expo/src/features/sessions/screens/SessionsListScreen.tsx
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";

import type { SessionGroup, SessionsListState } from "../session-types";
import type { SessionSummary } from "../session-types";
import { PrimaryButton, SecondaryButton } from "../../../ui/button";
import { AppCard } from "../../../ui/card";
import { colors, spacing, typography } from "../../../ui/theme";
import { SessionRow } from "../components/SessionRow";

function SessionGroupBlock({
  group,
  onSelect,
}: {
  group: SessionGroup;
  onSelect: (session: SessionSummary) => void;
}) {
  return (
    <View style={styles.group}>
      <Text style={styles.groupTitle}>{group.title}</Text>
      {group.items.map((session) => (
        <SessionRow key={session.sessionId} onPress={() => onSelect(session)} session={session} />
      ))}
    </View>
  );
}

export function SessionsListScreen({
  isNewSessionEnabled = false,
  onRefresh,
  onRetry,
  onSelectSession,
  state,
}: {
  isNewSessionEnabled?: boolean;
  onRefresh: () => void;
  onRetry: () => void;
  onSelectSession: (session: SessionSummary) => void;
  state: SessionsListState;
}) {
  const handleNewSession = () => {
    if (!isNewSessionEnabled) {
      Alert.alert("Coming soon", "New Session is coming soon in Expo.");
    }
  };

  if (state.status === "loading" && state.sessions.length === 0) {
    return (
      <View style={styles.centered}>
        <AppCard elevated style={styles.card}>
          <Text style={styles.title}>Loading sessions</Text>
          <Text style={styles.body}>We are checking your team's current sessions.</Text>
        </AppCard>
      </View>
    );
  }

  if (state.status === "error" && state.sessions.length === 0) {
    return (
      <View style={styles.centered}>
        <AppCard elevated style={styles.card}>
          <Text style={styles.title}>We couldn't load your sessions</Text>
          <Text style={styles.body}>{state.errorMessage}</Text>
          <PrimaryButton label="Try again" onPress={onRetry} />
        </AppCard>
      </View>
    );
  }

  if (state.status === "empty") {
    return (
      <View style={styles.centered}>
        <AppCard elevated style={styles.card}>
          <Text style={styles.title}>No Sessions</Text>
          <Text style={styles.body}>Start by browsing existing work here. New session creation is coming next.</Text>
          <SecondaryButton label="New Session" onPress={handleNewSession} />
        </AppCard>
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl onRefresh={onRefresh} refreshing={state.isRefreshing} tintColor={colors.coral} />}
    >
      <View style={styles.header}>
        <Text style={styles.screenTitle}>Sessions</Text>
        <SecondaryButton label="New Session" onPress={handleNewSession} />
      </View>
      {state.groups.map((group) => (
        <SessionGroupBlock group={group} key={group.id} onSelect={onSelectSession} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: {
    color: colors.ink2,
    ...typography.body,
  },
  card: {
    gap: spacing.md,
    maxWidth: 460,
    width: "100%",
  },
  centered: {
    alignItems: "center",
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: "center",
    padding: spacing.xxl,
  },
  content: {
    backgroundColor: colors.background,
    padding: spacing.xl,
  },
  group: {
    marginTop: spacing.lg,
  },
  groupTitle: {
    color: colors.faint,
    marginBottom: spacing.sm,
    ...typography.overline,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
    justifyContent: "space-between",
  },
  screenTitle: {
    color: colors.foreground,
    ...typography.sectionTitle,
  },
  title: {
    color: colors.foreground,
    ...typography.sectionTitle,
  },
});
```

- [ ] **Step 3: Wire the route stack and sessions index route**

```tsx
// apps/expo/app/(app)/_layout.tsx
import { Stack } from "expo-router";

import { colors } from "../../src/ui/theme";

export default function AppLayout() {
  return (
    <Stack
      screenOptions={{
        contentStyle: { backgroundColor: colors.background },
        headerShadowVisible: false,
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.foreground,
      }}
    />
  );
}
```

```tsx
// apps/expo/app/_layout.tsx
// update only this switch arm
case "ready":
  return "/(app)/sessions";
```

```tsx
// apps/expo/app/(app)/home.tsx
import { Redirect } from "expo-router";

export default function HomeRoute() {
  return <Redirect href="/(app)/sessions" />;
}
```

```tsx
// apps/expo/app/(app)/sessions/index.tsx
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useRouter } from "expo-router";

import { createSessionsApi } from "../../../src/features/sessions/session-api";
import { createSessionsController } from "../../../src/features/sessions/session-controller";
import { SessionsListScreen } from "../../../src/features/sessions/screens/SessionsListScreen";
import { supabase } from "../../../src/lib/supabase/client";
import { useOnboarding } from "../../_layout";

export default function SessionsIndexRoute() {
  const router = useRouter();
  const { state } = useOnboarding();

  const controller = useMemo(
    () => createSessionsController(createSessionsApi(supabase)),
    [],
  );

  const listState = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );

  useEffect(() => {
    if (state.route === "ready" && state.currentTeam) {
      void controller.load(state.currentTeam.id).catch(() => {});
    }
  }, [controller, state.currentTeam, state.route]);

  if (state.route !== "ready" || state.currentTeam === null) {
    return null;
  }

  return (
    <SessionsListScreen
      onRefresh={() => {
        void controller.refresh().catch(() => {});
      }}
      onRetry={() => {
        void controller.load(state.currentTeam!.id).catch(() => {});
      }}
      onSelectSession={(session) => {
        router.push(`/(app)/sessions/${session.sessionId}`);
      }}
      state={listState}
    />
  );
}
```

- [ ] **Step 4: Run the Expo test suite**

Run: `pnpm expo:test`

Expected: PASS with the existing onboarding tests still green.

- [ ] **Step 5: Commit**

```bash
git add apps/expo/app/_layout.tsx apps/expo/app/\(app\)/_layout.tsx apps/expo/app/\(app\)/home.tsx apps/expo/app/\(app\)/sessions/index.tsx apps/expo/src/features/sessions/components/SessionRow.tsx apps/expo/src/features/sessions/screens/SessionsListScreen.tsx
git commit -m "feat: add expo sessions list route"
```

## Task 5: Add the session detail shell

**Files:**
- Create: `apps/expo/src/features/sessions/screens/SessionDetailScreen.tsx`
- Create: `apps/expo/app/(app)/sessions/[sessionId].tsx`

- [ ] **Step 1: Create the detail screen**

```tsx
// apps/expo/src/features/sessions/screens/SessionDetailScreen.tsx
import { StyleSheet, Text, View } from "react-native";

import type { SessionSummary } from "../session-types";
import { PrimaryButton } from "../../../ui/button";
import { AppCard } from "../../../ui/card";
import { colors, spacing, typography } from "../../../ui/theme";

function formatDate(value: string | null): string {
  if (!value) {
    return "Not yet available";
  }

  return new Date(value).toLocaleString();
}

export function SessionDetailScreen({
  errorMessage,
  onBack,
  session,
  status,
}: {
  errorMessage: string | null;
  onBack: () => void;
  session: SessionSummary | null;
  status: "loading" | "loaded" | "notFound" | "error";
}) {
  if (status === "loading") {
    return (
      <View style={styles.centered}>
        <AppCard elevated style={styles.card}>
          <Text style={styles.title}>Opening session</Text>
          <Text style={styles.body}>We are loading the session details for this thread.</Text>
        </AppCard>
      </View>
    );
  }

  if (status === "notFound") {
    return (
      <View style={styles.centered}>
        <AppCard elevated style={styles.card}>
          <Text style={styles.title}>Session not found</Text>
          <Text style={styles.body}>This session could not be found for your current team.</Text>
          <PrimaryButton label="Back to Sessions" onPress={onBack} />
        </AppCard>
      </View>
    );
  }

  if (status === "error" || session === null) {
    return (
      <View style={styles.centered}>
        <AppCard elevated style={styles.card}>
          <Text style={styles.title}>We couldn't open this session</Text>
          <Text style={styles.body}>{errorMessage ?? "Please try again from the sessions list."}</Text>
          <PrimaryButton label="Back to Sessions" onPress={onBack} />
        </AppCard>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <AppCard elevated style={styles.card}>
        <Text style={styles.title}>{session.title.trim() || "Untitled Session"}</Text>
        <Text style={styles.body}>{session.summary.trim() || session.lastMessagePreview.trim() || "No messages yet"}</Text>
        <View style={styles.metaBlock}>
          <Text style={styles.metaLabel}>Participants</Text>
          <Text style={styles.metaValue}>{session.participantCount}</Text>
          <Text style={styles.metaLabel}>Created</Text>
          <Text style={styles.metaValue}>{formatDate(session.createdAt)}</Text>
          <Text style={styles.metaLabel}>Updated</Text>
          <Text style={styles.metaValue}>{formatDate(session.lastMessageAt)}</Text>
          <Text style={styles.metaLabel}>Session ID</Text>
          <Text style={styles.metaValue}>{session.sessionId}</Text>
        </View>
      </AppCard>
      <AppCard style={styles.notice}>
        <Text style={styles.noticeTitle}>Chat migration comes next</Text>
        <Text style={styles.body}>
          This Expo screen already loads real session metadata. Message history, sending, and streaming are the next migration phase.
        </Text>
      </AppCard>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    color: colors.ink2,
    ...typography.body,
  },
  card: {
    gap: spacing.md,
  },
  centered: {
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: "center",
    padding: spacing.xxl,
  },
  metaBlock: {
    borderColor: colors.borderSoft,
    borderTopWidth: 1,
    gap: spacing.xs,
    paddingTop: spacing.md,
  },
  metaLabel: {
    color: colors.faint,
    ...typography.overline,
  },
  metaValue: {
    color: colors.foreground,
    ...typography.body,
  },
  notice: {
    marginTop: spacing.lg,
  },
  noticeTitle: {
    color: colors.foreground,
    marginBottom: spacing.xs,
    ...typography.cardTitle,
  },
  screen: {
    backgroundColor: colors.background,
    flex: 1,
    padding: spacing.xl,
  },
  title: {
    color: colors.foreground,
    ...typography.sectionTitle,
  },
});
```

- [ ] **Step 2: Create the detail route**

```tsx
// apps/expo/app/(app)/sessions/[sessionId].tsx
import { useEffect, useMemo, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";

import { createSessionsApi } from "../../../src/features/sessions/session-api";
import type { SessionSummary } from "../../../src/features/sessions/session-types";
import { SessionDetailScreen } from "../../../src/features/sessions/screens/SessionDetailScreen";
import { supabase } from "../../../src/lib/supabase/client";

type DetailStatus = "loading" | "loaded" | "notFound" | "error";

export default function SessionDetailRoute() {
  const router = useRouter();
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const api = useMemo(() => createSessionsApi(supabase), []);
  const [status, setStatus] = useState<DetailStatus>("loading");
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let isActive = true;

    const run = async () => {
      setStatus("loading");
      setErrorMessage(null);

      try {
        const result = await api.getSession(sessionId);
        if (!isActive) {
          return;
        }

        if (result === null) {
          setSession(null);
          setStatus("notFound");
          return;
        }

        setSession(result);
        setStatus("loaded");
      } catch {
        if (!isActive) {
          return;
        }

        setSession(null);
        setErrorMessage("We couldn't open this session right now.");
        setStatus("error");
      }
    };

    void run();

    return () => {
      isActive = false;
    };
  }, [api, sessionId]);

  return (
    <SessionDetailScreen
      errorMessage={errorMessage}
      onBack={() => router.replace("/(app)/sessions")}
      session={session}
      status={status}
    />
  );
}
```

- [ ] **Step 3: Run the Expo test suite**

Run: `pnpm expo:test`

Expected: PASS with the sessions unit tests and existing onboarding tests all green.

- [ ] **Step 4: Commit**

```bash
git add apps/expo/app/\(app\)/sessions/\[sessionId\].tsx apps/expo/src/features/sessions/screens/SessionDetailScreen.tsx
git commit -m "feat: add expo session detail shell"
```

## Task 6: Update docs and verify the full Expo sessions slice

**Files:**
- Modify: `apps/expo/README.md`

- [ ] **Step 1: Update the README scope and route list**

```md
## Current scope

This package now covers:

- onboarding and auth routing
- authenticated Sessions landing route
- real session list loading
- session detail metadata shell
- placeholder New Session action

Current authenticated routes:

- `/(app)/sessions`
- `/(app)/sessions/[sessionId]`

Not yet migrated:

- session creation
- chat message history
- composer send flow
- realtime updates
```

- [ ] **Step 2: Run focused verification commands**

Run:

```sh
pnpm expo:test
pnpm --filter @teamclaw/expo exec node -e "console.log('sessions-plan-verification')"
```

Expected:

- `pnpm expo:test` passes
- the node command prints `sessions-plan-verification`

- [ ] **Step 3: Manual verification checklist**

Run this flow with valid Supabase env vars:

```text
1. Start Expo with pnpm expo:dev -- --clear
2. Sign in through the existing onboarding flow
3. Confirm the app lands on /(app)/sessions rather than the old home placeholder
4. Confirm the header shows Sessions and a New Session button
5. Pull to refresh the list
6. Open one session detail route
7. Confirm the detail view shows title, preview/summary, participant count, timestamps, and session id
8. Tap New Session and confirm the placeholder feedback appears
```

- [ ] **Step 4: Commit**

```bash
git add apps/expo/README.md
git commit -m "docs: document expo sessions scope"
```

## Self-Review

### Spec coverage

- authenticated route migration to sessions: covered by Task 4 and Task 5
- real list reads: covered by Task 2 and Task 3
- iOS-aligned row metadata: covered by Task 4
- detail metadata shell: covered by Task 5
- placeholder New Session action: covered by Task 4 and Task 6
- docs and manual verification: covered by Task 6

### Placeholder scan

- No `TODO`, `TBD`, or deferred implementation instructions remain inside the tasks.
- Each task names exact files and commands.
- Each code-writing step includes concrete code rather than generic direction.

### Type consistency

- Session list and detail both use `SessionSummary`.
- API names are consistent across tasks: `createSessionsApi`, `listSessions`, `getSession`.
- Controller names are consistent across tasks: `createSessionsController`, `load`, `refresh`.
