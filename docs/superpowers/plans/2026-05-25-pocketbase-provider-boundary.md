# PocketBase Provider Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Desktop and daemon main collaboration paths behind TeamClaw-owned backend provider interfaces while preserving Supabase behavior.

**Architecture:** Add a provider facade in `packages/app/src/lib/backend/` and make the existing Supabase client the first adapter. Migrate auth, session list, message persistence, attachment upload, and runtime metadata callers to the facade, then neutralize daemon backend error naming without changing its Supabase implementation.

**Tech Stack:** TypeScript, React/Zustand, Vitest, Supabase JS, Rust, async-trait, Cargo tests.

---

## Scope Check

This plan covers the approved first phase only:

- Desktop web app main path: auth, session list, session creation, outgoing message persistence, attachment upload, runtime metadata lookups.
- Daemon main runtime/session persistence path: provider-neutral trait result/error names.
- Supabase remains the only active provider.
- PocketBase is not implemented in this plan.
- iOS, Android, Expo, telemetry, shortcuts, ideas, and team git settings are not migrated unless a touched main-path file directly depends on them.

## File Structure

Create:

- `packages/app/src/lib/backend/types.ts`: provider-neutral TypeScript interfaces and DTOs.
- `packages/app/src/lib/backend/errors.ts`: provider-neutral error categories and Supabase error normalization helper.
- `packages/app/src/lib/backend/provider.ts`: singleton provider factory and config status.
- `packages/app/src/lib/backend/index.ts`: public exports.
- `packages/app/src/lib/backend/supabase/client.ts`: imports the existing configured Supabase singleton.
- `packages/app/src/lib/backend/supabase/auth.ts`: auth and invite adapter.
- `packages/app/src/lib/backend/supabase/sessions.ts`: session list, read marker, create, title, archive, participant adapter.
- `packages/app/src/lib/backend/supabase/messages.ts`: message history and outgoing insert adapter.
- `packages/app/src/lib/backend/supabase/runtime.ts`: agent runtime metadata adapter.
- `packages/app/src/lib/backend/supabase/attachments.ts`: Supabase Storage adapter.
- `packages/app/src/lib/backend/supabase/index.ts`: Supabase adapter composition.
- `packages/app/src/lib/backend/__tests__/provider.test.ts`: facade tests.
- `packages/app/src/lib/backend/supabase/__tests__/auth.test.ts`: auth adapter tests.
- `packages/app/src/lib/backend/supabase/__tests__/sessions.test.ts`: sessions adapter tests.
- `packages/app/src/lib/backend/supabase/__tests__/messages-runtime-attachments.test.ts`: remaining adapter tests.
- `apps/daemon/src/backend/error.rs`: provider-neutral daemon backend error/result.

Modify:

- `packages/app/src/stores/auth-store.ts`
- `packages/app/src/stores/auth-store.test.ts`
- `packages/app/src/stores/session-list-store.ts`
- `packages/app/src/stores/session-list-store.test.ts`
- `packages/app/src/lib/session-create.ts`
- `packages/app/src/lib/__tests__/session-create.test.ts`
- `packages/app/src/services/outbox-sender.ts`
- `packages/app/src/services/__tests__/outbox-sender.test.ts`
- `packages/app/src/lib/attachment-upload.ts`
- Add or update attachment upload tests if none exist.
- `apps/daemon/src/backend/mod.rs`
- `apps/daemon/src/backend/mock.rs`
- `apps/daemon/src/supabase/client.rs`
- `apps/daemon/src/supabase/mod.rs`

Verification commands:

- `pnpm --filter @teamclaw/app test:unit -- src/lib/backend src/stores/auth-store.test.ts src/stores/session-list-store.test.ts src/lib/__tests__/session-create.test.ts src/services/__tests__/outbox-sender.test.ts`
- `pnpm --filter @teamclaw/app typecheck`
- `cargo test -p amuxd backend`
- `cargo test -p amuxd`

## Task 1: Desktop Backend Core Facade

**Files:**

- Create: `packages/app/src/lib/backend/types.ts`
- Create: `packages/app/src/lib/backend/errors.ts`
- Create: `packages/app/src/lib/backend/provider.ts`
- Create: `packages/app/src/lib/backend/index.ts`
- Create: `packages/app/src/lib/backend/supabase/client.ts`
- Create: `packages/app/src/lib/backend/supabase/index.ts`
- Test: `packages/app/src/lib/backend/__tests__/provider.test.ts`

- [ ] **Step 1: Write the failing provider facade test**

Create `packages/app/src/lib/backend/__tests__/provider.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasSupabaseConfig: true,
  supabase: { marker: "supabase-client" },
}));

vi.mock("@/lib/supabase-client", () => ({
  get hasSupabaseConfig() {
    return mocks.hasSupabaseConfig;
  },
  SUPABASE_CONFIG_MISSING_MESSAGE:
    "Supabase config missing. Configure a server before signing in.",
  supabase: mocks.supabase,
}));

describe("backend provider facade", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.hasSupabaseConfig = true;
  });

  it("defaults to a Supabase backend singleton", async () => {
    const { getBackend } = await import("../provider");

    const first = getBackend();
    const second = getBackend();

    expect(first).toBe(second);
    expect(first.kind).toBe("supabase");
    expect(first.auth).toBeDefined();
    expect(first.sessions).toBeDefined();
    expect(first.messages).toBeDefined();
    expect(first.runtime).toBeDefined();
    expect(first.attachments).toBeDefined();
  });

  it("reports backend config status using existing Supabase config", async () => {
    const { hasBackendConfig, BACKEND_CONFIG_MISSING_MESSAGE } = await import("../provider");

    expect(hasBackendConfig()).toBe(true);
    mocks.hasSupabaseConfig = false;
    expect(hasBackendConfig()).toBe(false);
    expect(BACKEND_CONFIG_MISSING_MESSAGE).toMatch(/Supabase config missing/);
  });
});
```

- [ ] **Step 2: Run the provider facade test and verify it fails**

Run:

```bash
pnpm --filter @teamclaw/app test:unit -- src/lib/backend/__tests__/provider.test.ts
```

Expected: FAIL because `packages/app/src/lib/backend/provider.ts` does not exist.

- [ ] **Step 3: Add provider-neutral types**

Create `packages/app/src/lib/backend/types.ts`:

```ts
import type { Session } from "@supabase/supabase-js";

export type BackendKind = "supabase" | "pocketbase" | "local";

export type AuthSession = Session;

export interface AuthClaimResult {
  actorId: string;
  teamId: string;
  actorType: string;
  displayName: string;
  refreshToken: string | null;
}

export type Unsubscribe = () => void;

export interface AuthBackend {
  getSession(): Promise<AuthSession | null>;
  onAuthStateChange(listener: (session: AuthSession | null) => void): Unsubscribe;
  sendOtp(email: string): Promise<void>;
  verifyOtp(email: string, code: string): Promise<AuthSession | null>;
  signInAnonymously(): Promise<AuthSession | null>;
  signOut(): Promise<void>;
  claimInvite(token: string): Promise<AuthClaimResult>;
}

export interface SessionListEntry {
  id: string;
  title: string;
  team_id: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  mode: "solo" | "collab" | "control";
  idea_id: string | null;
  has_unread: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface SessionListCursor {
  lastMessageAt: string | null;
  createdAt: string | null;
  id: string;
}

export interface SessionListPage {
  rows: SessionListEntry[];
}

export interface SessionCreateInput {
  id: string;
  teamId: string;
  createdByActorId: string;
  title: string;
  additionalActorIds: string[];
  ideaId?: string | null;
}

export interface SessionParticipant {
  session_id: string;
  actor_id: string;
  role?: string | null;
}

export interface SessionsBackend {
  listCurrentActorSessions(args: {
    limit: number;
    cursor: SessionListCursor | null;
  }): Promise<SessionListPage>;
  markCurrentActorSessionViewed(
    sessionId: string,
    lastReadMessageId?: string | null,
  ): Promise<void>;
  createSessionShell(input: SessionCreateInput): Promise<{ sessionId: string }>;
  addParticipants(sessionId: string, actorIds: string[]): Promise<void>;
  updateSessionTitle(sessionId: string, title: string): Promise<void>;
  archiveSession(sessionId: string, archivedAt: string): Promise<void>;
  getSessionParticipants(sessionId: string): Promise<SessionParticipant[]>;
  listSessionsForTeamSince(teamId: string, updatedAfter: string | null): Promise<SessionListEntry[]>;
}

export interface OutgoingMessageInput {
  id: string;
  teamId: string;
  sessionId: string;
  senderActorId: string;
  kind?: "text" | "agent_reply" | string;
  content: string;
  model?: string | null;
  metadata?: Record<string, unknown> | null;
  turnId?: string | null;
  replyToMessageId?: string | null;
  attachments?: unknown[] | null;
  createdAt?: string | null;
}

export interface MessageHistoryRow {
  id: string;
  team_id: string;
  session_id: string;
  turn_id?: string | null;
  sender_actor_id?: string | null;
  reply_to_message_id?: string | null;
  kind: string;
  content: string;
  metadata?: unknown | null;
  model?: string | null;
  created_at: string;
  updated_at?: string | null;
  attachments?: unknown[] | null;
}

export interface MessagesBackend {
  insertOutgoingMessage(input: OutgoingMessageInput): Promise<void>;
  listMessages(sessionId: string): Promise<MessageHistoryRow[]>;
  updateMessageContent(messageId: string, content: string): Promise<void>;
  listMessagesForSessionSince(
    sessionId: string,
    updatedAfter: string | null,
  ): Promise<MessageHistoryRow[]>;
}

export interface AgentRuntimeSummary {
  id: string;
  agent_id: string;
  workspace_id: string | null;
  backend_type: string | null;
  runtime_id?: string | null;
  session_id?: string | null;
  status?: string | null;
  current_model?: string | null;
  updated_at?: string | null;
}

export interface RuntimeBackend {
  listLatestAgentRuntimeHints(teamId: string, agentActorIds: string[]): Promise<AgentRuntimeSummary[]>;
  listAgentDefaults(agentActorIds: string[]): Promise<Array<{
    id: string;
    agent_types: string[] | null;
    default_agent_type: string | null;
  }>>;
  updateRuntimeModel(runtimeId: string, model: string): Promise<void>;
}

export interface AttachmentUploadInput {
  file: File;
  teamId: string;
  sessionId: string;
}

export interface AttachmentRef {
  attachmentId: string;
  fileName: string;
  signedUrl: string;
  mimeType: string;
  size: number;
}

export interface AttachmentsBackend {
  uploadAttachment(input: AttachmentUploadInput): Promise<AttachmentRef>;
}

export interface DirectoryBackend {
  resolveCurrentMemberActor(teamId: string, userId: string): Promise<{ id: string } | null>;
}

export interface TeamClawBackend {
  kind: BackendKind;
  auth: AuthBackend;
  directory: DirectoryBackend;
  sessions: SessionsBackend;
  messages: MessagesBackend;
  runtime: RuntimeBackend;
  attachments: AttachmentsBackend;
}
```

- [ ] **Step 4: Add provider-neutral error helpers**

Create `packages/app/src/lib/backend/errors.ts`:

```ts
export type BackendErrorCategory =
  | "Unauthenticated"
  | "Forbidden"
  | "NotFound"
  | "Conflict"
  | "Validation"
  | "Unavailable"
  | "Timeout"
  | "RateLimited"
  | "Provider"
  | "Unknown";

export class BackendError extends Error {
  readonly category: BackendErrorCategory;
  readonly provider?: string;
  readonly operation?: string;
  readonly causeValue?: unknown;

  constructor(args: {
    category: BackendErrorCategory;
    message: string;
    provider?: string;
    operation?: string;
    cause?: unknown;
  }) {
    super(args.message);
    this.name = "BackendError";
    this.category = args.category;
    this.provider = args.provider;
    this.operation = args.operation;
    this.causeValue = args.cause;
  }
}

type SupabaseLikeError = {
  message?: string;
  code?: string;
  status?: number;
  name?: string;
};

function categoryFromSupabase(error: SupabaseLikeError): BackendErrorCategory {
  if (error.status === 401) return "Unauthenticated";
  if (error.status === 403 || error.code === "42501") return "Forbidden";
  if (error.status === 404 || error.code === "PGRST116") return "NotFound";
  if (error.status === 409 || error.code === "23505") return "Conflict";
  if (error.status === 422 || error.code === "23514" || error.code === "23502") return "Validation";
  if (error.status === 429) return "RateLimited";
  if (error.name === "AbortError") return "Timeout";
  return "Provider";
}

export function toBackendError(error: unknown, operation: string): BackendError {
  if (error instanceof BackendError) return error;
  if (error && typeof error === "object") {
    const supabaseError = error as SupabaseLikeError;
    return new BackendError({
      category: categoryFromSupabase(supabaseError),
      message: supabaseError.message ?? "Backend request failed",
      provider: "supabase",
      operation,
      cause: error,
    });
  }
  return new BackendError({
    category: "Unknown",
    message: String(error || "Backend request failed"),
    operation,
    cause: error,
  });
}
```

- [ ] **Step 5: Add Supabase adapter composition shell**

Create `packages/app/src/lib/backend/supabase/client.ts`:

```ts
import { supabase } from "@/lib/supabase-client";

export { supabase };
```

Create `packages/app/src/lib/backend/supabase/index.ts`. This file composes the adapter modules created across Tasks 2 through 4, so complete those adapter files before running typecheck:

```ts
import type { TeamClawBackend } from "../types";
import { createSupabaseAttachmentsBackend } from "./attachments";
import { createSupabaseAuthBackend } from "./auth";
import { createSupabaseDirectoryBackend } from "./directory";
import { createSupabaseMessagesBackend } from "./messages";
import { createSupabaseRuntimeBackend } from "./runtime";
import { createSupabaseSessionsBackend } from "./sessions";

export function createSupabaseBackend(): TeamClawBackend {
  return {
    kind: "supabase",
    auth: createSupabaseAuthBackend(),
    directory: createSupabaseDirectoryBackend(),
    sessions: createSupabaseSessionsBackend(),
    messages: createSupabaseMessagesBackend(),
    runtime: createSupabaseRuntimeBackend(),
    attachments: createSupabaseAttachmentsBackend(),
  };
}
```

When this step is implemented, create the adapter files listed in Tasks 2 through 5 in the same working tree before running typecheck, because `index.ts` imports them.

- [ ] **Step 6: Add provider factory and public exports**

Create `packages/app/src/lib/backend/provider.ts`:

```ts
import {
  hasSupabaseConfig,
  SUPABASE_CONFIG_MISSING_MESSAGE,
} from "@/lib/supabase-client";
import type { TeamClawBackend } from "./types";
import { createSupabaseBackend } from "./supabase";

let singleton: TeamClawBackend | null = null;

export const BACKEND_CONFIG_MISSING_MESSAGE = SUPABASE_CONFIG_MISSING_MESSAGE;

export function hasBackendConfig(): boolean {
  return hasSupabaseConfig;
}

export function getBackend(): TeamClawBackend {
  if (!singleton) singleton = createSupabaseBackend();
  return singleton;
}

export function resetBackendForTests(): void {
  singleton = null;
}
```

Create `packages/app/src/lib/backend/index.ts`:

```ts
export {
  BACKEND_CONFIG_MISSING_MESSAGE,
  getBackend,
  hasBackendConfig,
  resetBackendForTests,
} from "./provider";
export { BackendError, toBackendError } from "./errors";
export type * from "./types";
```

- [ ] **Step 7: Run the provider test after adapter files exist**

Run after Tasks 2 through 5 create the adapter modules:

```bash
pnpm --filter @teamclaw/app test:unit -- src/lib/backend/__tests__/provider.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/app/src/lib/backend
git commit -m "feat(app): add backend provider facade"
```

## Task 2: Auth Adapter and Auth Store Migration

**Files:**

- Create: `packages/app/src/lib/backend/supabase/auth.ts`
- Create: `packages/app/src/lib/backend/supabase/directory.ts`
- Test: `packages/app/src/lib/backend/supabase/__tests__/auth.test.ts`
- Modify: `packages/app/src/stores/auth-store.ts`
- Modify: `packages/app/src/stores/auth-store.test.ts`

- [ ] **Step 1: Write auth adapter tests**

Create `packages/app/src/lib/backend/supabase/__tests__/auth.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  signInWithOtp: vi.fn(),
  verifyOtp: vi.fn(),
  signInAnonymously: vi.fn(),
  signOut: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/lib/supabase-client", () => ({
  supabase: {
    auth: {
      getSession: mocks.getSession,
      onAuthStateChange: mocks.onAuthStateChange,
      signInWithOtp: mocks.signInWithOtp,
      verifyOtp: mocks.verifyOtp,
      signInAnonymously: mocks.signInAnonymously,
      signOut: mocks.signOut,
    },
    rpc: mocks.rpc,
    from: mocks.from,
  },
}));

describe("Supabase auth backend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("gets the current session", async () => {
    mocks.getSession.mockResolvedValueOnce({ data: { session: { user: { id: "u1" } } } });
    const { createSupabaseAuthBackend } = await import("../auth");

    const session = await createSupabaseAuthBackend().getSession();

    expect(session?.user.id).toBe("u1");
  });

  it("subscribes to auth state changes and returns an unsubscribe function", async () => {
    const unsubscribe = vi.fn();
    mocks.onAuthStateChange.mockReturnValueOnce({
      data: { subscription: { unsubscribe } },
    });
    const listener = vi.fn();
    const { createSupabaseAuthBackend } = await import("../auth");

    const stop = createSupabaseAuthBackend().onAuthStateChange(listener);
    const callback = mocks.onAuthStateChange.mock.calls[0][0] as (_event: string, session: unknown) => void;
    callback("SIGNED_IN", { user: { id: "u2" } });
    stop();

    expect(listener).toHaveBeenCalledWith({ user: { id: "u2" } });
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("claims an invite through the existing Supabase RPC", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        actor_id: "actor-1",
        team_id: "team-1",
        actor_type: "member",
        display_name: "Alice",
        refresh_token: null,
      },
      error: null,
    });
    const { createSupabaseAuthBackend } = await import("../auth");

    const result = await createSupabaseAuthBackend().claimInvite("tok-1");

    expect(mocks.rpc).toHaveBeenCalledWith("claim_team_invite", { p_token: "tok-1" });
    expect(result).toMatchObject({ actorId: "actor-1", teamId: "team-1" });
  });

  it("resolves the current member actor id through the directory adapter", async () => {
    const maybeSingle = vi.fn().mockResolvedValueOnce({ data: { id: "actor-2" }, error: null });
    const limit = vi.fn(() => ({ maybeSingle }));
    const eq3 = vi.fn(() => ({ limit }));
    const eq2 = vi.fn(() => ({ eq: eq3 }));
    const eq1 = vi.fn(() => ({ eq: eq2 }));
    const select = vi.fn(() => ({ eq: eq1 }));
    mocks.from.mockReturnValueOnce({ select });
    const { createSupabaseDirectoryBackend } = await import("../directory");

    const actor = await createSupabaseDirectoryBackend().resolveCurrentMemberActor("team-1", "user-1");

    expect(mocks.from).toHaveBeenCalledWith("actors");
    expect(actor?.id).toBe("actor-2");
  });
});
```

- [ ] **Step 2: Run auth adapter tests and verify they fail**

Run:

```bash
pnpm --filter @teamclaw/app test:unit -- src/lib/backend/supabase/__tests__/auth.test.ts
```

Expected: FAIL because `auth.ts` and `directory.ts` do not exist.

- [ ] **Step 3: Implement the Supabase auth adapter**

Create `packages/app/src/lib/backend/supabase/auth.ts`:

```ts
import type { AuthBackend, AuthClaimResult } from "../types";
import { toBackendError } from "../errors";
import { supabase } from "./client";

interface AuthClaimRow {
  actor_id: string;
  team_id: string;
  actor_type: string;
  display_name: string;
  refresh_token?: string | null;
}

function mapClaimResult(row: AuthClaimRow): AuthClaimResult {
  return {
    actorId: row.actor_id,
    teamId: row.team_id,
    actorType: row.actor_type,
    displayName: row.display_name,
    refreshToken: row.refresh_token ?? null,
  };
}

export function createSupabaseAuthBackend(): AuthBackend {
  return {
    async getSession() {
      const { data } = await supabase.auth.getSession();
      return data.session;
    },

    onAuthStateChange(listener) {
      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        listener(session);
      });
      return () => data.subscription.unsubscribe();
    },

    async sendOtp(email) {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true },
      });
      if (error) throw toBackendError(error, "auth.sendOtp");
    },

    async verifyOtp(email, code) {
      const { data, error } = await supabase.auth.verifyOtp({
        email,
        token: code,
        type: "email",
      });
      if (error) throw toBackendError(error, "auth.verifyOtp");
      return data.session;
    },

    async signInAnonymously() {
      const { data, error } = await supabase.auth.signInAnonymously();
      if (error) throw toBackendError(error, "auth.signInAnonymously");
      return data.session;
    },

    async signOut() {
      const { error } = await supabase.auth.signOut();
      if (error) throw toBackendError(error, "auth.signOut");
    },

    async claimInvite(token) {
      const { data, error } = await supabase.rpc("claim_team_invite", { p_token: token });
      if (error) throw toBackendError(error, "auth.claimInvite");
      const row = (Array.isArray(data) ? data[0] : data) as AuthClaimRow | null;
      if (!row) {
        throw toBackendError({ message: "Invite claim returned no team.", status: 404 }, "auth.claimInvite");
      }
      return mapClaimResult(row);
    },
  };
}
```

- [ ] **Step 4: Implement the minimal directory adapter used by the main path**

Create `packages/app/src/lib/backend/supabase/directory.ts`:

```ts
import type { DirectoryBackend } from "../types";
import { toBackendError } from "../errors";
import { supabase } from "./client";

export function createSupabaseDirectoryBackend(): DirectoryBackend {
  return {
    async resolveCurrentMemberActor(teamId, userId) {
      const { data, error } = await supabase
        .from("actors")
        .select("id")
        .eq("team_id", teamId)
        .eq("user_id", userId)
        .eq("actor_type", "member")
        .limit(1)
        .maybeSingle();
      if (error) throw toBackendError(error, "directory.resolveCurrentMemberActor");
      return data ? { id: data.id } : null;
    },
  };
}
```

- [ ] **Step 5: Migrate auth-store to the backend facade**

Modify `packages/app/src/stores/auth-store.ts`:

```ts
import { create } from "zustand";
import {
  BACKEND_CONFIG_MISSING_MESSAGE,
  getBackend,
  hasBackendConfig,
  type AuthSession,
} from "@/lib/backend";
```

Replace the `Session` type in state with `AuthSession`:

```ts
interface AuthState {
  session: AuthSession | null;
  loading: boolean;
  authFlow: AuthFlow;
  errorMessage: string | null;
  otpEmail: string | null;
  hydrate: () => Promise<void>;
  sendOtp: (email: string) => Promise<boolean>;
  verifyOtp: (code: string) => Promise<void>;
  resetOtp: () => void;
  signInAnonymously: () => Promise<boolean>;
  claimInvite: (token: string) => Promise<AuthClaimResult | null>;
  claimInviteAfterAnonymousSignIn: (token: string) => Promise<AuthClaimResult | null>;
  signOut: () => Promise<void>;
}
```

Replace the old `claimInviteToken` helper with:

```ts
async function claimInviteToken(token: string): Promise<AuthClaimResult | { errorMessage: string }> {
  try {
    return await getBackend().auth.claimInvite(token);
  } catch (error) {
    return { errorMessage: error instanceof Error ? error.message : String(error) };
  }
}
```

Update the store methods:

```ts
hydrate: async () => {
  set({ loading: true, authFlow: "idle", errorMessage: null });
  const session = await getBackend().auth.getSession();
  set({ session, loading: false });
  getBackend().auth.onAuthStateChange((session) => {
    set({ session });
  });
},
sendOtp: async (email) => {
  if (!hasBackendConfig()) {
    set({ loading: false, errorMessage: BACKEND_CONFIG_MISSING_MESSAGE });
    return false;
  }
  set({ loading: true, authFlow: "idle", errorMessage: null });
  try {
    await getBackend().auth.sendOtp(email);
    set({ loading: false, otpEmail: email });
    return true;
  } catch (error) {
    set({ loading: false, errorMessage: error instanceof Error ? error.message : String(error) });
    return false;
  }
},
verifyOtp: async (code) => {
  if (!hasBackendConfig()) {
    set({ loading: false, errorMessage: BACKEND_CONFIG_MISSING_MESSAGE });
    return;
  }
  const email = get().otpEmail;
  if (!email) {
    set({ errorMessage: "No pending sign-in. Re-enter your email." });
    return;
  }
  set({ loading: true, authFlow: "idle", errorMessage: null });
  try {
    const session = await getBackend().auth.verifyOtp(email, code);
    set({ session, loading: false, otpEmail: null });
  } catch (error) {
    set({ loading: false, errorMessage: error instanceof Error ? error.message : String(error) });
  }
},
signInAnonymously: async () => {
  if (!hasBackendConfig()) {
    set({ loading: false, errorMessage: BACKEND_CONFIG_MISSING_MESSAGE });
    return false;
  }
  set({ loading: true, authFlow: "idle", errorMessage: null });
  try {
    const session = await getBackend().auth.signInAnonymously();
    set({ session, loading: false, otpEmail: null });
    return true;
  } catch (error) {
    set({ loading: false, errorMessage: error instanceof Error ? error.message : String(error) });
    return false;
  }
},
signOut: async () => {
  await getBackend().auth.signOut();
  set({ session: null, authFlow: "idle", otpEmail: null });
},
```

In `claimInviteAfterAnonymousSignIn`, replace the anonymous sign-in call with:

```ts
const session = await getBackend().auth.signInAnonymously();
set({ session, otpEmail: null });
```

Wrap that block in the existing error path so failed sign-in sets `authFlow: "idle"` and the error message.

- [ ] **Step 6: Update auth-store tests to mock the backend facade**

In `packages/app/src/stores/auth-store.test.ts`, replace the Supabase mock with a backend mock:

```ts
const backendMock = {
  auth: {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(),
    sendOtp: vi.fn(),
    verifyOtp: vi.fn(),
    signOut: vi.fn(),
    signInAnonymously: vi.fn(),
    claimInvite: vi.fn(),
  },
};
const backendConfig = { hasConfig: true };

vi.mock("@/lib/backend", () => ({
  get hasBackendConfig() {
    return () => backendConfig.hasConfig;
  },
  BACKEND_CONFIG_MISSING_MESSAGE: "Supabase config missing. Configure a server before signing in.",
  getBackend: () => backendMock,
}));
```

Update expectations:

```ts
expect(backendMock.auth.claimInvite).toHaveBeenCalledWith("tok-1");
expect(backendMock.auth.signInAnonymously).toHaveBeenCalled();
expect(backendMock.auth.sendOtp).not.toHaveBeenCalled();
```

For error tests, make backend methods reject:

```ts
backendMock.auth.sendOtp.mockRejectedValueOnce(new Error("rate limit"));
backendMock.auth.verifyOtp.mockRejectedValueOnce(new Error("Invalid code"));
backendMock.auth.claimInvite.mockRejectedValueOnce(new Error("Invite expired"));
```

- [ ] **Step 7: Run auth tests**

Run:

```bash
pnpm --filter @teamclaw/app test:unit -- src/lib/backend/supabase/__tests__/auth.test.ts src/stores/auth-store.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/app/src/lib/backend packages/app/src/stores/auth-store.ts packages/app/src/stores/auth-store.test.ts
git commit -m "feat(app): route auth through backend facade"
```

## Task 3: Sessions Adapter and Session List Migration

**Files:**

- Create: `packages/app/src/lib/backend/supabase/sessions.ts`
- Test: `packages/app/src/lib/backend/supabase/__tests__/sessions.test.ts`
- Modify: `packages/app/src/stores/session-list-store.ts`
- Modify: `packages/app/src/stores/session-list-store.test.ts`

- [ ] **Step 1: Write sessions adapter tests**

Create `packages/app/src/lib/backend/supabase/__tests__/sessions.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/lib/supabase-client", () => ({
  supabase: {
    rpc: mocks.rpc,
    from: mocks.from,
  },
}));

const freshRow = {
  id: "session-1",
  title: "Session",
  team_id: "team-1",
  mode: "collab",
  idea_id: null,
  last_message_at: "2026-05-17T08:00:00.000Z",
  last_message_preview: "preview",
  created_at: "2026-05-17T07:59:00.000Z",
  updated_at: "2026-05-17T08:00:01.000Z",
  has_unread: true,
};

describe("Supabase sessions backend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists current actor sessions through the existing RPC", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [freshRow], error: null });
    const { createSupabaseSessionsBackend } = await import("../sessions");

    const page = await createSupabaseSessionsBackend().listCurrentActorSessions({
      limit: 25,
      cursor: {
        lastMessageAt: "2026-05-17T08:00:00.000Z",
        createdAt: "2026-05-17T07:59:00.000Z",
        id: "session-1",
      },
    });

    expect(mocks.rpc).toHaveBeenCalledWith("list_current_actor_sessions", {
      p_limit: 25,
      p_before_last_message_at: "2026-05-17T08:00:00.000Z",
      p_before_created_at: "2026-05-17T07:59:00.000Z",
      p_before_id: "session-1",
    });
    expect(page.rows[0]).toMatchObject({ id: "session-1", has_unread: true });
  });

  it("creates a session shell and inserts participants", async () => {
    const sessionInsert = vi.fn().mockResolvedValueOnce({ error: null });
    const participantInsert = vi.fn().mockResolvedValueOnce({ error: null });
    mocks.from.mockImplementation((table: string) => {
      if (table === "sessions") return { insert: sessionInsert };
      if (table === "session_participants") return { insert: participantInsert };
      throw new Error(`unexpected table: ${table}`);
    });
    const { createSupabaseSessionsBackend } = await import("../sessions");

    const result = await createSupabaseSessionsBackend().createSessionShell({
      id: "session-2",
      teamId: "team-1",
      createdByActorId: "member-1",
      title: "Hello",
      additionalActorIds: ["agent-1"],
      ideaId: null,
    });

    expect(result.sessionId).toBe("session-2");
    expect(sessionInsert).toHaveBeenCalledWith(expect.objectContaining({
      id: "session-2",
      team_id: "team-1",
      created_by_actor_id: "member-1",
      mode: "collab",
      title: "Hello",
    }));
    expect(participantInsert).toHaveBeenCalledWith([
      { session_id: "session-2", actor_id: "member-1" },
      { session_id: "session-2", actor_id: "agent-1" },
    ]);
  });
});
```

- [ ] **Step 2: Run sessions adapter tests and verify they fail**

Run:

```bash
pnpm --filter @teamclaw/app test:unit -- src/lib/backend/supabase/__tests__/sessions.test.ts
```

Expected: FAIL because `sessions.ts` does not exist.

- [ ] **Step 3: Implement the Supabase sessions adapter**

Create `packages/app/src/lib/backend/supabase/sessions.ts`:

```ts
import type { SessionListEntry, SessionsBackend } from "../types";
import { toBackendError } from "../errors";
import { supabase } from "./client";

type FreshSessionRow = {
  id: string;
  title: string;
  team_id: string;
  mode: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  created_at: string;
  updated_at: string;
  idea_id: string | null;
  has_unread: boolean | null;
};

const SYNC_COLUMNS =
  "id, team_id, title, mode, idea_id, last_message_at, last_message_preview, created_at, updated_at";

function mapFreshToEntry(r: FreshSessionRow): SessionListEntry {
  return {
    id: r.id,
    title: r.title ?? "",
    team_id: r.team_id,
    last_message_at: r.last_message_at,
    last_message_preview: r.last_message_preview,
    mode: (r.mode as SessionListEntry["mode"]) ?? "solo",
    idea_id: r.idea_id ?? null,
    has_unread: r.has_unread === true,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function createSupabaseSessionsBackend(): SessionsBackend {
  return {
    async listCurrentActorSessions({ limit, cursor }) {
      const { data, error } = await supabase.rpc("list_current_actor_sessions", {
        p_limit: limit,
        p_before_last_message_at: cursor?.lastMessageAt ?? null,
        p_before_created_at: cursor?.createdAt ?? null,
        p_before_id: cursor?.id ?? null,
      });
      if (error) throw toBackendError(error, "sessions.listCurrentActorSessions");
      return { rows: ((data ?? []) as FreshSessionRow[]).map(mapFreshToEntry) };
    },

    async markCurrentActorSessionViewed(sessionId, lastReadMessageId = null) {
      const { error } = await supabase.rpc("mark_current_actor_session_viewed", {
        p_session_id: sessionId,
        p_last_read_message_id: lastReadMessageId,
      });
      if (error) throw toBackendError(error, "sessions.markCurrentActorSessionViewed");
    },

    async createSessionShell(input) {
      const { error: sessionErr } = await supabase.from("sessions").insert({
        id: input.id,
        team_id: input.teamId,
        created_by_actor_id: input.createdByActorId,
        mode: "collab",
        title: input.title,
        idea_id: input.ideaId ?? null,
      });
      if (sessionErr) throw toBackendError(sessionErr, "sessions.createSessionShell.insertSession");

      const participantActorIds = Array.from(
        new Set([input.createdByActorId, ...input.additionalActorIds]),
      );
      if (participantActorIds.length > 0) {
        const { error: partErr } = await supabase
          .from("session_participants")
          .insert(participantActorIds.map((actorId) => ({
            session_id: input.id,
            actor_id: actorId,
          })));
        if (partErr) throw toBackendError(partErr, "sessions.createSessionShell.insertParticipants");
      }
      return { sessionId: input.id };
    },

    async addParticipants(sessionId, actorIds) {
      if (actorIds.length === 0) return;
      const { error } = await supabase
        .from("session_participants")
        .upsert(
          actorIds.map((actorId) => ({ session_id: sessionId, actor_id: actorId })),
          { onConflict: "session_id,actor_id" },
        );
      if (error) throw toBackendError(error, "sessions.addParticipants");
    },

    async updateSessionTitle(sessionId, title) {
      const { error } = await supabase
        .from("sessions")
        .update({ title })
        .eq("id", sessionId);
      if (error) throw toBackendError(error, "sessions.updateSessionTitle");
    },

    async archiveSession(sessionId, archivedAt) {
      const { error } = await supabase
        .from("sessions")
        .update({ archived_at: archivedAt })
        .eq("id", sessionId);
      if (error) throw toBackendError(error, "sessions.archiveSession");
    },

    async getSessionParticipants(sessionId) {
      const { data, error } = await supabase
        .from("session_participants")
        .select("session_id, actor_id, role")
        .eq("session_id", sessionId);
      if (error) throw toBackendError(error, "sessions.getSessionParticipants");
      return data ?? [];
    },

    async listSessionsForTeamSince(teamId, updatedAfter) {
      let query = supabase
        .from("sessions")
        .select(SYNC_COLUMNS)
        .eq("team_id", teamId);
      if (updatedAfter) query = query.gt("updated_at", updatedAfter);
      const { data, error } = await query;
      if (error) throw toBackendError(error, "sessions.listSessionsForTeamSince");
      return ((data ?? []) as FreshSessionRow[]).map(mapFreshToEntry);
    },
  };
}
```

- [ ] **Step 4: Migrate session-list-store to the backend facade**

Modify `packages/app/src/stores/session-list-store.ts`:

```ts
import { getBackend } from "@/lib/backend";
```

Remove the direct `supabase` import.

Replace `loadPage` with:

```ts
async function loadPage(limit: number, cursor: State["nextCursor"]) {
  try {
    const page = await getBackend().sessions.listCurrentActorSessions({
      limit,
      cursor,
    });
    return { data: page.rows, error: null as { message: string } | null };
  } catch (error) {
    return {
      data: [] as SessionListEntry[],
      error: { message: error instanceof Error ? error.message : String(error) },
    };
  }
}
```

Replace `markSessionViewed` body:

```ts
markSessionViewed: async (sessionId, lastReadMessageId = null) => {
  try {
    await getBackend().sessions.markCurrentActorSessionViewed(sessionId, lastReadMessageId);
    get().patchRow(sessionId, { has_unread: false });
  } catch (error) {
    set({ error: error instanceof Error ? error.message : String(error) });
  }
},
```

Replace `updateSessionTitle` body:

```ts
updateSessionTitle: async (sessionId, title) => {
  const trimmed = title.trim();
  if (!trimmed) return;
  try {
    await getBackend().sessions.updateSessionTitle(sessionId, trimmed);
    get().patchRow(sessionId, { title: trimmed });
  } catch (error) {
    set({ error: error instanceof Error ? error.message : String(error) });
  }
},
```

Replace `archiveSession` body:

```ts
archiveSession: async (sessionId) => {
  const archivedAt = new Date().toISOString();
  try {
    await getBackend().sessions.archiveSession(sessionId, archivedAt);
    get().removeRow(sessionId);
  } catch (error) {
    set({ error: error instanceof Error ? error.message : String(error) });
  }
},
```

- [ ] **Step 5: Update session-list-store tests to mock the backend**

In `packages/app/src/stores/session-list-store.test.ts`, replace the Supabase mock with:

```ts
const mocks = vi.hoisted(() => ({
  listCurrentActorSessions: vi.fn(),
  markCurrentActorSessionViewed: vi.fn(),
  updateSessionTitle: vi.fn(),
  archiveSession: vi.fn(),
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    sessions: {
      listCurrentActorSessions: mocks.listCurrentActorSessions,
      markCurrentActorSessionViewed: mocks.markCurrentActorSessionViewed,
      updateSessionTitle: mocks.updateSessionTitle,
      archiveSession: mocks.archiveSession,
    },
  }),
}));
```

Update expectations:

```ts
expect(mocks.listCurrentActorSessions).toHaveBeenCalledWith({
  limit: 50,
  cursor: null,
});
expect(mocks.markCurrentActorSessionViewed).toHaveBeenCalledWith("session-1", null);
expect(mocks.updateSessionTitle).toHaveBeenCalledWith("session-1", "Renamed");
expect(mocks.archiveSession).toHaveBeenCalledWith("session-1", expect.any(String));
```

Set list mock responses:

```ts
mocks.listCurrentActorSessions.mockResolvedValueOnce({
  rows: [sessionRow({ has_unread: true })],
});
```

- [ ] **Step 6: Run session tests**

Run:

```bash
pnpm --filter @teamclaw/app test:unit -- src/lib/backend/supabase/__tests__/sessions.test.ts src/stores/session-list-store.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/lib/backend/supabase/sessions.ts packages/app/src/lib/backend/supabase/__tests__/sessions.test.ts packages/app/src/stores/session-list-store.ts packages/app/src/stores/session-list-store.test.ts
git commit -m "feat(app): route session list through backend facade"
```

## Task 4: Messages, Runtime, Attachments, and Session Creation Migration

**Files:**

- Create: `packages/app/src/lib/backend/supabase/messages.ts`
- Create: `packages/app/src/lib/backend/supabase/runtime.ts`
- Create: `packages/app/src/lib/backend/supabase/attachments.ts`
- Test: `packages/app/src/lib/backend/supabase/__tests__/messages-runtime-attachments.test.ts`
- Modify: `packages/app/src/lib/session-create.ts`
- Modify: `packages/app/src/lib/__tests__/session-create.test.ts`
- Modify: `packages/app/src/services/outbox-sender.ts`
- Modify: `packages/app/src/services/__tests__/outbox-sender.test.ts`
- Modify: `packages/app/src/lib/attachment-upload.ts`

- [ ] **Step 1: Write adapter tests for messages, runtime, and attachments**

Create `packages/app/src/lib/backend/supabase/__tests__/messages-runtime-attachments.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  storageFrom: vi.fn(),
  randomUUID: vi.fn(),
}));

vi.mock("@/lib/supabase-client", () => ({
  supabase: {
    from: mocks.from,
    storage: {
      from: mocks.storageFrom,
    },
  },
}));

describe("Supabase messages/runtime/attachments backend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.randomUUID.mockReturnValue("attachment-1");
    vi.stubGlobal("crypto", { randomUUID: mocks.randomUUID });
  });

  it("inserts outgoing messages into the messages table", async () => {
    const insert = vi.fn().mockResolvedValueOnce({ error: null });
    mocks.from.mockReturnValueOnce({ insert });
    const { createSupabaseMessagesBackend } = await import("../messages");

    await createSupabaseMessagesBackend().insertOutgoingMessage({
      id: "msg-1",
      teamId: "team-1",
      sessionId: "session-1",
      senderActorId: "member-1",
      content: "hello",
      model: "model-1",
      metadata: { mention_actor_ids: ["agent-1"] },
    });

    expect(mocks.from).toHaveBeenCalledWith("messages");
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      id: "msg-1",
      team_id: "team-1",
      session_id: "session-1",
      sender_actor_id: "member-1",
      kind: "text",
      content: "hello",
      model: "model-1",
    }));
  });

  it("loads latest runtime hints and agent defaults", async () => {
    const runtimeOrder = vi.fn().mockResolvedValueOnce({
      data: [{ id: "rt-row-1", agent_id: "agent-1", workspace_id: "ws-1", backend_type: "opencode" }],
      error: null,
    });
    const runtimeEq = vi.fn(() => ({ order: runtimeOrder }));
    const runtimeIn = vi.fn(() => ({ eq: runtimeEq }));
    const runtimeSelect = vi.fn(() => ({ in: runtimeIn }));

    const agentIn = vi.fn().mockResolvedValueOnce({
      data: [{ id: "agent-1", agent_types: ["opencode"], default_agent_type: "opencode" }],
      error: null,
    });
    const agentSelect = vi.fn(() => ({ in: agentIn }));

    mocks.from.mockImplementation((table: string) => {
      if (table === "agent_runtimes") return { select: runtimeSelect };
      if (table === "agents") return { select: agentSelect };
      throw new Error(`unexpected table: ${table}`);
    });

    const { createSupabaseRuntimeBackend } = await import("../runtime");
    const backend = createSupabaseRuntimeBackend();

    await expect(backend.listLatestAgentRuntimeHints("team-1", ["agent-1"])).resolves.toHaveLength(1);
    await expect(backend.listAgentDefaults(["agent-1"])).resolves.toHaveLength(1);
  });

  it("uploads attachments to Supabase Storage and returns a signed URL", async () => {
    const upload = vi.fn().mockResolvedValueOnce({ error: null });
    const createSignedUrl = vi.fn().mockResolvedValueOnce({
      data: { signedUrl: "https://signed.example/file.png" },
      error: null,
    });
    mocks.storageFrom.mockReturnValue({ upload, createSignedUrl });
    const file = new File(["abc"], "file.png", { type: "image/png" });
    const { createSupabaseAttachmentsBackend } = await import("../attachments");

    const result = await createSupabaseAttachmentsBackend().uploadAttachment({
      file,
      teamId: "team-1",
      sessionId: "session-1",
    });

    expect(upload).toHaveBeenCalledWith(
      "team-1/session-1/attachment-1/file.png",
      file,
      { contentType: "image/png", upsert: false },
    );
    expect(createSignedUrl).toHaveBeenCalledWith(
      "team-1/session-1/attachment-1/file.png",
      31536000,
    );
    expect(result.signedUrl).toBe("https://signed.example/file.png");
  });
});
```

- [ ] **Step 2: Run adapter tests and verify they fail**

Run:

```bash
pnpm --filter @teamclaw/app test:unit -- src/lib/backend/supabase/__tests__/messages-runtime-attachments.test.ts
```

Expected: FAIL because the adapter files do not exist.

- [ ] **Step 3: Implement messages adapter**

Create `packages/app/src/lib/backend/supabase/messages.ts`:

```ts
import type { MessagesBackend } from "../types";
import { toBackendError } from "../errors";
import { supabase } from "./client";

const MESSAGE_COLUMNS =
  "id, team_id, session_id, turn_id, sender_actor_id, reply_to_message_id, kind, content, metadata, model, created_at, updated_at, attachments";

export function createSupabaseMessagesBackend(): MessagesBackend {
  return {
    async insertOutgoingMessage(input) {
      const payload: Record<string, unknown> = {
        id: input.id,
        team_id: input.teamId,
        session_id: input.sessionId,
        sender_actor_id: input.senderActorId,
        kind: input.kind ?? "text",
        content: input.content,
        model: input.model ?? null,
        metadata: input.metadata ?? null,
        turn_id: input.turnId ?? null,
        reply_to_message_id: input.replyToMessageId ?? null,
      };
      if (input.attachments && input.attachments.length > 0) payload.attachments = input.attachments;
      if (input.createdAt) payload.created_at = input.createdAt;

      const { error } = await supabase.from("messages").insert(payload);
      if (error) throw toBackendError(error, "messages.insertOutgoingMessage");
    },

    async listMessages(sessionId) {
      const { data, error } = await supabase
        .from("messages")
        .select(MESSAGE_COLUMNS)
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true });
      if (error) throw toBackendError(error, "messages.listMessages");
      return data ?? [];
    },

    async updateMessageContent(messageId, content) {
      const { error } = await supabase
        .from("messages")
        .update({ content, updated_at: new Date().toISOString() })
        .eq("id", messageId);
      if (error) throw toBackendError(error, "messages.updateMessageContent");
    },

    async listMessagesForSessionSince(sessionId, updatedAfter) {
      let query = supabase
        .from("messages")
        .select(MESSAGE_COLUMNS)
        .eq("session_id", sessionId);
      if (updatedAfter) query = query.gt("updated_at", updatedAfter);
      const { data, error } = await query;
      if (error) throw toBackendError(error, "messages.listMessagesForSessionSince");
      return data ?? [];
    },
  };
}
```

- [ ] **Step 4: Implement runtime adapter**

Create `packages/app/src/lib/backend/supabase/runtime.ts`:

```ts
import type { RuntimeBackend } from "../types";
import { toBackendError } from "../errors";
import { supabase } from "./client";

export function createSupabaseRuntimeBackend(): RuntimeBackend {
  return {
    async listLatestAgentRuntimeHints(teamId, agentActorIds) {
      if (agentActorIds.length === 0) return [];
      const { data, error } = await supabase
        .from("agent_runtimes")
        .select("id, agent_id, workspace_id, backend_type, runtime_id, session_id, status, current_model, updated_at")
        .in("agent_id", agentActorIds)
        .eq("team_id", teamId)
        .order("updated_at", { ascending: false });
      if (error) throw toBackendError(error, "runtime.listLatestAgentRuntimeHints");
      return data ?? [];
    },

    async listAgentDefaults(agentActorIds) {
      if (agentActorIds.length === 0) return [];
      const { data, error } = await supabase
        .from("agents")
        .select("id, agent_types, default_agent_type")
        .in("id", agentActorIds);
      if (error) throw toBackendError(error, "runtime.listAgentDefaults");
      return data ?? [];
    },

    async updateRuntimeModel(runtimeId, model) {
      const { error } = await supabase
        .from("agent_runtimes")
        .update({ current_model: model, updated_at: new Date().toISOString() })
        .eq("id", runtimeId);
      if (error) throw toBackendError(error, "runtime.updateRuntimeModel");
    },
  };
}
```

- [ ] **Step 5: Implement attachments adapter**

Create `packages/app/src/lib/backend/supabase/attachments.ts`:

```ts
import type { AttachmentsBackend } from "../types";
import { toBackendError } from "../errors";
import { supabase } from "./client";

const SIGNED_URL_TTL_SECONDS = 31536000;

export function createSupabaseAttachmentsBackend(): AttachmentsBackend {
  return {
    async uploadAttachment({ file, teamId, sessionId }) {
      const attachmentId = crypto.randomUUID();
      const storagePath = `${teamId}/${sessionId}/${attachmentId}/${file.name}`;

      const { error: uploadError } = await supabase.storage
        .from("attachments")
        .upload(storagePath, file, { contentType: file.type, upsert: false });
      if (uploadError) throw toBackendError(uploadError, "attachments.upload");

      const { data: signedData, error: signError } = await supabase.storage
        .from("attachments")
        .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
      if (signError) throw toBackendError(signError, "attachments.createSignedUrl");

      return {
        attachmentId,
        fileName: file.name,
        signedUrl: signedData.signedUrl,
        mimeType: file.type,
        size: file.size,
      };
    },
  };
}
```

- [ ] **Step 6: Migrate `attachment-upload.ts`**

Replace direct Supabase usage in `packages/app/src/lib/attachment-upload.ts` with:

```ts
import { getBackend } from "@/lib/backend";

export interface UploadedAttachment {
  attachmentId: string;
  fileName: string;
  signedUrl: string;
  mimeType: string;
  size: number;
}

export async function uploadAttachment(
  file: File,
  { teamId, sessionId }: { teamId: string; sessionId: string },
): Promise<UploadedAttachment> {
  return getBackend().attachments.uploadAttachment({ file, teamId, sessionId });
}
```

- [ ] **Step 7: Migrate outgoing message persistence in `outbox-sender.ts`**

In `packages/app/src/services/outbox-sender.ts`, replace:

```ts
import { supabase } from "@/lib/supabase-client";
```

with:

```ts
import { BackendError, getBackend } from "@/lib/backend";
```

Replace the insert block with:

```ts
try {
  await getBackend().messages.insertOutgoingMessage({
    id: entry.messageId,
    teamId: entry.teamId,
    sessionId: entry.sessionId,
    senderActorId: entry.senderActorId,
    kind: "text",
    content: entry.content,
    model: entry.model ?? null,
    metadata: {
      mention_actor_ids: entry.mentionActorIds,
      ...(entry.attachmentUrls.length > 0
        ? { attachment_urls: entry.attachmentUrls }
        : {}),
    },
  });
  sessionFlowLog("outbox_sender.backend_insert.ok", {
    messageId: entry.messageId,
    sessionId: entry.sessionId,
    teamId: entry.teamId,
    duplicateAlreadyInserted: false,
  });
} catch (error) {
  if (error instanceof BackendError && error.category === "Conflict") {
    sessionFlowLog("outbox_sender.backend_insert.ok", {
      messageId: entry.messageId,
      sessionId: entry.sessionId,
      teamId: entry.teamId,
      duplicateAlreadyInserted: true,
    });
  } else {
    throw error;
  }
}
```

Keep the conflict-as-success behavior. It replaces the old Supabase `23505` check with provider-neutral `Conflict`.

- [ ] **Step 8: Migrate session creation and runtime lookups in `session-create.ts`**

In `packages/app/src/lib/session-create.ts`, replace the Supabase import with:

```ts
import { getBackend } from "@/lib/backend";
```

In `createSessionShell`, replace the direct session and participant inserts with:

```ts
await getBackend().sessions.createSessionShell({
  id: sessionId,
  teamId: args.teamId,
  createdByActorId: args.creatorActorId,
  title: trimmedTitle,
  additionalActorIds: args.additionalActorIds,
  ideaId: args.ideaId ?? null,
});
```

In `createSessionWithFirstMessage`, replace the direct message insert with:

```ts
await getBackend().messages.insertOutgoingMessage({
  id: messageId,
  teamId: args.teamId,
  sessionId,
  senderActorId: args.creatorActorId,
  kind: "text",
  content: trimmed,
  model: args.modelId ?? null,
  metadata: { mention_actor_ids: [] },
});
```

In `startAgentRuntimesAsync`, replace prior runtime and agent default queries:

```ts
const priorRows = await getBackend().runtime.listLatestAgentRuntimeHints(
  args.teamId,
  args.agentActorIds,
);
for (const r of priorRows) {
  if (!priorByAgent.has(r.agent_id)) {
    priorByAgent.set(r.agent_id, {
      workspace_id: r.workspace_id,
      backend_type: r.backend_type ?? null,
    });
  }
}

const agentRows = await getBackend().runtime.listAgentDefaults(args.agentActorIds);
for (const r of agentRows) {
  defaultByAgent.set(r.id, {
    agent_types: normalizeAgentTypes(r.agent_types),
    default_agent_type: r.default_agent_type ?? null,
  });
}
```

- [ ] **Step 9: Update tests that mocked Supabase directly**

In `packages/app/src/services/__tests__/outbox-sender.test.ts`, replace the Supabase mock with:

```ts
const mocks = vi.hoisted(() => ({
  mqttPublish: vi.fn(),
  insertOutgoingMessage: vi.fn(),
  upsertOutbox: vi.fn(),
  deleteOutbox: vi.fn(),
  listAllOutbox: vi.fn(),
}));

vi.mock("@/lib/backend", async () => {
  const actual = await vi.importActual<typeof import("@/lib/backend")>("@/lib/backend");
  return {
    ...actual,
    getBackend: () => ({
      messages: {
        insertOutgoingMessage: mocks.insertOutgoingMessage,
      },
    }),
  };
});
```

Update expectations:

```ts
expect(mocks.insertOutgoingMessage).toHaveBeenCalledWith(
  expect.objectContaining({
    model: "opencode/qwen3.6-plus-free",
  }),
);
```

In `packages/app/src/lib/__tests__/session-create.test.ts`, replace `supabaseFrom` with:

```ts
const backendMock = {
  sessions: {
    createSessionShell: vi.fn(),
  },
  messages: {
    insertOutgoingMessage: vi.fn(),
  },
  runtime: {
    listLatestAgentRuntimeHints: vi.fn(),
    listAgentDefaults: vi.fn(),
  },
};

vi.mock("@/lib/backend", () => ({
  getBackend: () => backendMock,
}));
```

Rewrite `mockTables` as:

```ts
function mockBackendTables(opts: {
  runtimes?: Array<{ agent_id: string; workspace_id: string | null; backend_type: string | null }>;
  actors?: Array<{ id: string; agent_types: string[]; default_agent_type: string | null }>;
}) {
  backendMock.runtime.listLatestAgentRuntimeHints.mockResolvedValue(
    (opts.runtimes ?? []).map((r) => ({
      ...r,
      id: `${r.agent_id}-runtime`,
      updated_at: "2026-05-18T00:00:00.000Z",
    })),
  );
  backendMock.runtime.listAgentDefaults.mockResolvedValue(opts.actors ?? []);
}
```

- [ ] **Step 10: Run migrated main-path tests**

Run:

```bash
pnpm --filter @teamclaw/app test:unit -- src/lib/backend/supabase/__tests__/messages-runtime-attachments.test.ts src/lib/__tests__/session-create.test.ts src/services/__tests__/outbox-sender.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/app/src/lib/backend packages/app/src/lib/session-create.ts packages/app/src/lib/__tests__/session-create.test.ts packages/app/src/services/outbox-sender.ts packages/app/src/services/__tests__/outbox-sender.test.ts packages/app/src/lib/attachment-upload.ts
git commit -m "feat(app): route messages runtime and attachments through backend facade"
```

## Task 5: Session and Message Cache Sync Facade Methods

**Files:**

- Modify: `packages/app/src/lib/sync/session-sync.ts`
- Modify: `packages/app/src/lib/sync/message-sync.ts`
- Test: add focused tests if existing sync tests are absent.

- [ ] **Step 1: Check for existing sync tests**

Run:

```bash
rg -n "syncSessionsForTeam|syncMessagesForSession" packages/app/src -g "*.test.ts"
```

Expected: either existing tests are listed or no output. If no output, add tests in the next step.

- [ ] **Step 2: Add focused sync tests if none exist**

Create `packages/app/src/lib/sync/session-message-sync.test.ts` if the `rg` command found no tests:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isTauri: true,
  getWatermark: vi.fn(),
  setWatermark: vi.fn(),
  upsertSessionsBatch: vi.fn(),
  upsertMessagesBatch: vi.fn(),
  listSessionsForTeamSince: vi.fn(),
  listMessagesForSessionSince: vi.fn(),
}));

vi.mock("@/lib/utils", () => ({ isTauri: () => mocks.isTauri }));
vi.mock("@/lib/local-cache", () => ({
  getWatermark: mocks.getWatermark,
  setWatermark: mocks.setWatermark,
  upsertSessionsBatch: mocks.upsertSessionsBatch,
  upsertMessagesBatch: mocks.upsertMessagesBatch,
}));
vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    sessions: { listSessionsForTeamSince: mocks.listSessionsForTeamSince },
    messages: { listMessagesForSessionSince: mocks.listMessagesForSessionSince },
  }),
}));

describe("provider-backed cache sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isTauri = true;
  });

  it("syncs sessions through the backend facade", async () => {
    mocks.getWatermark.mockResolvedValueOnce("2026-05-01T00:00:00.000Z");
    mocks.listSessionsForTeamSince.mockResolvedValueOnce([{
      id: "session-1",
      title: "Session",
      team_id: "team-1",
      mode: "collab",
      idea_id: null,
      last_message_preview: null,
      last_message_at: null,
      has_unread: false,
      created_at: "2026-05-02T00:00:00.000Z",
      updated_at: "2026-05-02T00:00:00.000Z",
    }]);
    const { syncSessionsForTeam } = await import("./session-sync");

    await expect(syncSessionsForTeam("team-1")).resolves.toBe(1);

    expect(mocks.listSessionsForTeamSince).toHaveBeenCalledWith("team-1", "2026-05-01T00:00:00.000Z");
    expect(mocks.upsertSessionsBatch).toHaveBeenCalledWith([
      expect.objectContaining({ id: "session-1", teamId: "team-1" }),
    ]);
  });

  it("syncs messages through the backend facade", async () => {
    mocks.getWatermark.mockResolvedValueOnce(null);
    mocks.listMessagesForSessionSince.mockResolvedValueOnce([{
      id: "msg-1",
      team_id: "team-1",
      session_id: "session-1",
      kind: "text",
      content: "hello",
      metadata: { x: 1 },
      created_at: "2026-05-02T00:00:00.000Z",
      updated_at: "2026-05-02T00:00:00.000Z",
    }]);
    const { syncMessagesForSession } = await import("./message-sync");

    await expect(syncMessagesForSession("session-1", "team-1")).resolves.toBe(1);

    expect(mocks.listMessagesForSessionSince).toHaveBeenCalledWith("session-1", null);
    expect(mocks.upsertMessagesBatch).toHaveBeenCalledWith([
      expect.objectContaining({ id: "msg-1", teamId: "team-1", origin: "supabase" }),
    ]);
  });
});
```

- [ ] **Step 3: Run sync tests and verify they fail before migration**

Run:

```bash
pnpm --filter @teamclaw/app test:unit -- src/lib/sync/session-message-sync.test.ts
```

Expected: FAIL if the new test was added and sync modules still call Supabase through `cache-sync.ts`.

- [ ] **Step 4: Migrate `session-sync.ts` remote reads**

In `packages/app/src/lib/sync/session-sync.ts`, remove `syncTableForTeam` import and add:

```ts
import { getBackend } from "@/lib/backend";
```

Replace the function body with:

```ts
export async function syncSessionsForTeam(
  teamId: string,
  opts?: { full?: boolean },
): Promise<number> {
  if (!isTauri()) return 0;
  const watermark = opts?.full ? null : await cache.getWatermark("sessions", teamId);
  const remoteRows = await getBackend().sessions.listSessionsForTeamSince(teamId, watermark);
  const rows = remoteRows.map(mapRow);
  if (rows.length > 0) {
    await cache.upsertSessionsBatch(rows);
    const maxUpdated = rows.reduce<string>((acc, row) => (
      row.updatedAt && row.updatedAt > acc ? row.updatedAt : acc
    ), watermark ?? "");
    if (maxUpdated) await cache.setWatermark("sessions", teamId, maxUpdated);
  }
  return rows.length;
}
```

- [ ] **Step 5: Migrate `message-sync.ts` remote reads**

In `packages/app/src/lib/sync/message-sync.ts`, remove `syncTableForSession` import and add:

```ts
import { getBackend } from "@/lib/backend";
```

Replace the function body with:

```ts
export async function syncMessagesForSession(
  sessionId: string,
  teamId: string,
  opts?: { full?: boolean },
): Promise<number> {
  if (!isTauri()) return 0;
  const wmKey = `messages:${sessionId}`;
  const watermark = opts?.full ? null : await cache.getWatermark(wmKey, teamId);
  const remoteRows = await getBackend().messages.listMessagesForSessionSince(sessionId, watermark);
  const rows = remoteRows.map(mapRow);
  if (rows.length > 0) {
    await cache.upsertMessagesBatch(rows);
    const maxUpdated = rows.reduce<string>((acc, row) => (
      row.updatedAt && row.updatedAt > acc ? row.updatedAt : acc
    ), watermark ?? "");
    if (maxUpdated) await cache.setWatermark(wmKey, teamId, maxUpdated);
  }
  return rows.length;
}
```

- [ ] **Step 6: Run sync tests**

Run:

```bash
pnpm --filter @teamclaw/app test:unit -- src/lib/sync/session-message-sync.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/lib/sync/session-sync.ts packages/app/src/lib/sync/message-sync.ts packages/app/src/lib/sync/session-message-sync.test.ts
git commit -m "feat(app): route cache sync reads through backend facade"
```

## Task 6: Daemon Provider-Neutral Backend Error

**Files:**

- Create: `apps/daemon/src/backend/error.rs`
- Modify: `apps/daemon/src/backend/mod.rs`
- Modify: `apps/daemon/src/backend/mock.rs`
- Modify: `apps/daemon/src/supabase/client.rs`
- Modify: `apps/daemon/src/supabase/mod.rs`

- [ ] **Step 1: Add backend error module tests first**

Add tests to the bottom of new `apps/daemon/src/backend/error.rs` when creating it in Step 3. The test code should be:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::supabase::SupabaseError;

    #[test]
    fn maps_supabase_invite_invalid_to_backend_validation() {
        let err = BackendError::from(SupabaseError::InviteInvalid);
        assert!(matches!(err, BackendError::Validation(_)));
    }

    #[test]
    fn maps_supabase_rpc_to_provider_error() {
        let err = BackendError::from(SupabaseError::Rpc {
            code: Some("42501".into()),
            message: "forbidden".into(),
        });
        assert!(matches!(err, BackendError::Provider { provider: "supabase", .. }));
    }
}
```

- [ ] **Step 2: Run daemon backend tests and verify they fail**

Run:

```bash
cargo test -p amuxd backend::error
```

Expected: FAIL because `apps/daemon/src/backend/error.rs` is not wired yet.

- [ ] **Step 3: Implement `BackendError` and `BackendResult`**

Create `apps/daemon/src/backend/error.rs`:

```rust
use thiserror::Error;

use crate::supabase::SupabaseError;

#[derive(Debug, Error)]
pub enum BackendError {
    #[error("auth error: {0}")]
    Auth(String),

    #[error("validation error: {0}")]
    Validation(String),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("provider error from {provider}: {message}")]
    Provider {
        provider: &'static str,
        code: Option<String>,
        message: String,
    },

    #[error("config error: {0}")]
    Config(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),
}

pub type BackendResult<T> = Result<T, BackendError>;

impl From<SupabaseError> for BackendError {
    fn from(value: SupabaseError) -> Self {
        match value {
            SupabaseError::Auth(message) | SupabaseError::InvalidJwt(message) => {
                BackendError::Auth(message)
            }
            SupabaseError::InviteInvalid => {
                BackendError::Validation("invite invalid or expired".into())
            }
            SupabaseError::InviteClaimed => {
                BackendError::Validation("invite already claimed".into())
            }
            SupabaseError::Rpc { code, message } => BackendError::Provider {
                provider: "supabase",
                code,
                message,
            },
            SupabaseError::Config(message) => BackendError::Config(message),
            SupabaseError::Network(err) => BackendError::Provider {
                provider: "supabase",
                code: None,
                message: err.to_string(),
            },
            SupabaseError::Io(err) => BackendError::Io(err),
            SupabaseError::Serde(err) => BackendError::Serde(err),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supabase::SupabaseError;

    #[test]
    fn maps_supabase_invite_invalid_to_backend_validation() {
        let err = BackendError::from(SupabaseError::InviteInvalid);
        assert!(matches!(err, BackendError::Validation(_)));
    }

    #[test]
    fn maps_supabase_rpc_to_provider_error() {
        let err = BackendError::from(SupabaseError::Rpc {
            code: Some("42501".into()),
            message: "forbidden".into(),
        });
        assert!(matches!(err, BackendError::Provider { provider: "supabase", .. }));
    }
}
```

- [ ] **Step 4: Wire backend error module**

In `apps/daemon/src/backend/mod.rs`, add:

```rust
pub mod error;
pub use error::{BackendError, BackendResult};
```

Replace:

```rust
use crate::supabase::error::SupabaseResult;
```

with:

```rust
use crate::backend::BackendResult;
```

Change every trait method return type from `SupabaseResult<...>` to `BackendResult<...>`.

- [ ] **Step 5: Update mock backend return types**

In `apps/daemon/src/backend/mock.rs`, replace:

```rust
use crate::supabase::error::{SupabaseError, SupabaseResult};
```

with:

```rust
use crate::backend::{BackendError, BackendResult};
```

Change every impl method return type from `SupabaseResult<...>` to `BackendResult<...>`.

Replace mock errors:

```rust
.ok_or(SupabaseError::InviteInvalid)
```

with:

```rust
.ok_or_else(|| BackendError::Validation("invite invalid or expired".into()))
```

Replace `SupabaseError::Rpc { code, message }` mock errors with:

```rust
BackendError::Provider {
    provider: "mock",
    code,
    message,
}
```

- [ ] **Step 6: Update SupabaseBackend trait impl return types**

In `apps/daemon/src/supabase/client.rs`, inside:

```rust
impl crate::backend::Backend for SupabaseBackend {
```

change method return types to `crate::backend::BackendResult<...>`.

When a method returns a Supabase error explicitly, convert it:

```rust
return Err(SupabaseError::Rpc {
    code: Some(status.as_u16().to_string()),
    message: text,
}.into());
```

When a method ends with a `SupabaseResult<T>` expression, use `Ok(expr?)` or `.map_err(Into::into)`.

Example:

```rust
async fn auth_token(&self) -> crate::backend::BackendResult<String> {
    Ok(self.access_token().await?)
}
```

- [ ] **Step 7: Keep Supabase-specific inherent methods unchanged**

Do not change `SupabaseBackend::new`, `SupabaseBackend::rpc`, `SupabaseConfig`, onboarding config parsing, or `crate::supabase::SupabaseResult` outside the `Backend` trait impl. Those are provider implementation details and still valid.

- [ ] **Step 8: Run daemon backend tests**

Run:

```bash
cargo test -p amuxd backend
```

Expected: PASS.

- [ ] **Step 9: Run full daemon tests**

Run:

```bash
cargo test -p amuxd
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/daemon/src/backend apps/daemon/src/supabase/client.rs apps/daemon/src/supabase/mod.rs
git commit -m "feat(daemon): neutralize backend error boundary"
```

## Task 7: Final Import Audit and Verification

**Files:**

- Inspect: `packages/app/src`
- Inspect: `apps/daemon/src`
- Modify only if an import is part of the main path already migrated.

- [ ] **Step 1: Audit Desktop direct Supabase imports in migrated main-path files**

Run:

```bash
rg -n "@/lib/supabase-client|supabase\\.from|supabase\\.rpc|supabase\\.storage|supabase\\.auth" packages/app/src/stores/auth-store.ts packages/app/src/stores/session-list-store.ts packages/app/src/lib/session-create.ts packages/app/src/services/outbox-sender.ts packages/app/src/lib/attachment-upload.ts packages/app/src/lib/sync/session-sync.ts packages/app/src/lib/sync/message-sync.ts
```

Expected: no output.

- [ ] **Step 2: Audit remaining Desktop Supabase imports and record intentional leftovers**

Run:

```bash
rg -n "@/lib/supabase-client|supabase\\.from|supabase\\.rpc|supabase\\.storage|supabase\\.auth" packages/app/src -g "!**/__tests__/**" -g "!**/*.test.ts"
```

Expected: remaining hits in secondary surfaces such as telemetry, shortcuts, ideas, team settings, panels, or old compatibility UI. Do not migrate those in this PR unless they are required by the main path tests.

- [ ] **Step 3: Run app unit tests for touched paths**

Run:

```bash
pnpm --filter @teamclaw/app test:unit -- src/lib/backend src/stores/auth-store.test.ts src/stores/session-list-store.test.ts src/lib/__tests__/session-create.test.ts src/services/__tests__/outbox-sender.test.ts src/lib/sync/session-message-sync.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run app typecheck**

Run:

```bash
pnpm --filter @teamclaw/app typecheck
```

Expected: PASS.

- [ ] **Step 5: Run daemon tests**

Run:

```bash
cargo test -p amuxd
```

Expected: PASS.

- [ ] **Step 6: Review final diff**

Run:

```bash
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

Expected: diff only includes backend facade, migrated main-path callers/tests, daemon backend error boundary, and the approved docs. `git diff --check` has no whitespace errors.

- [ ] **Step 7: Commit verification cleanup if any**

If Step 6 required small fixes:

```bash
git add <changed-files>
git commit -m "chore: finish backend provider boundary migration"
```

If no fixes were needed, do not create an empty commit.

## Self-Review Notes

- Spec coverage: Desktop facade, Supabase adapter, auth/session/message/runtime/attachment migration, cache sync, daemon backend error neutralization, and tests are covered.
- PocketBase adapter is intentionally absent.
- Mobile clients are intentionally absent.
- Supabase schema changes are intentionally absent.
- MQTT behavior is untouched except existing callers still publish after provider-backed persistence.
- Secondary Supabase imports remain outside this phase and are explicitly audited in Task 7.
