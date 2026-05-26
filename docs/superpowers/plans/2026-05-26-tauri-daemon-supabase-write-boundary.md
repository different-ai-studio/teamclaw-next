# Tauri and Daemon Supabase Write Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every Tauri Desktop and daemon Supabase write behind provider-owned boundaries, while preserving current Supabase behavior.

**Architecture:** Add a source-scan guardrail first, then extend the existing Desktop `TeamClawBackend` facade with domain services for teams, ideas, actors, session members, shortcuts, notifications, workspace config, and telemetry. Keep app Supabase calls in `packages/app/src/lib/backend/supabase/**`; keep daemon remote writes in `apps/daemon/src/supabase/**`; change daemon business logic to consume provider-neutral backend DTOs and names.

**Tech Stack:** TypeScript, React, Zustand, Vitest, Supabase JS adapter tests, Rust, async-trait, Cargo tests.

---

## Scope Check

The design spans several product surfaces, but the work has one shared outcome:
no Tauri Desktop or daemon Supabase writes outside provider boundaries. The plan
is split by independently testable boundary batches so each task can land and
verify without requiring the whole migration to be complete.

## File Structure

Create:

- `packages/app/src/lib/backend/__tests__/supabase-boundary.test.ts`: source-scan guardrail for disallowed Supabase imports and writes in Desktop product code.
- `packages/app/src/lib/backend/supabase/teams.ts`: Supabase adapter for team create/rename/invite/remove actor workflows.
- `packages/app/src/lib/backend/supabase/ideas.ts`: Supabase adapter for idea create/update/archive/activity/detail workflows.
- `packages/app/src/lib/backend/supabase/actors.ts`: Supabase adapter for actor directory, connected agents, and agent profile/default writes.
- `packages/app/src/lib/backend/supabase/session-members.ts`: Supabase adapter for session participants and candidate actors.
- `packages/app/src/lib/backend/supabase/shortcuts.ts`: Supabase adapter for shortcut create/update/delete/move/visibility.
- `packages/app/src/lib/backend/supabase/notifications.ts`: Supabase adapter for notification prefs and session mutes.
- `packages/app/src/lib/backend/supabase/team-workspace-config.ts`: Supabase adapter for team workspace config.
- `packages/app/src/lib/backend/supabase/telemetry.ts`: Supabase adapter for feedback/session report writes.
- `packages/app/src/lib/backend/supabase/__tests__/teams-ideas-actors.test.ts`: adapter tests for teams, ideas, actors.
- `packages/app/src/lib/backend/supabase/__tests__/product-services.test.ts`: adapter tests for session members, shortcuts, notifications, workspace config, telemetry.
- `apps/daemon/src/backend/records.rs`: provider-neutral daemon DTOs currently leaked from Supabase row types.

Modify:

- `packages/app/src/lib/backend/types.ts`: add service interfaces and DTOs.
- `packages/app/src/lib/backend/supabase/index.ts`: compose new Supabase services.
- `packages/app/src/stores/session-messages.ts`
- `packages/app/src/stores/current-team.ts`
- `packages/app/src/stores/telemetry.ts`
- `packages/app/src/lib/daemon-workspaces.ts`
- `packages/app/src/lib/team-workspace-config.ts`
- `packages/app/src/lib/notifications/preferences.ts`
- `packages/app/src/lib/idea-mutations.ts`
- `packages/app/src/lib/shortcuts-rpc.ts`
- `packages/app/src/lib/daemon-agent-admin.ts`
- `packages/app/src/lib/telemetry/supabase-feedback.ts`
- `packages/app/src/lib/telemetry/supabase-session-report.ts`
- `packages/app/src/components/auth/AuthGate.tsx`
- `packages/app/src/components/auth/LoginScreen.tsx`
- `packages/app/src/components/settings/team/TeamGitConfig.tsx`
- `packages/app/src/components/chat/ActorChatInput.tsx`
- `packages/app/src/components/chat/SessionActorSheet.tsx`
- `packages/app/src/components/chat/ChatPanel.tsx`
- `packages/app/src/components/chat/MentionPopover.tsx`
- `packages/app/src/components/chat/NewSessionDialog.tsx`
- `packages/app/src/components/chat/AgentSelectorDock.tsx`
- `packages/app/src/components/sidebar/InviteActorDialog.tsx`
- `packages/app/src/components/sidebar/CreateIdeaDialog.tsx`
- `packages/app/src/components/sidebar/IdeaDetailDialog.tsx`
- `packages/app/src/components/sidebar/IdeasSection.tsx`
- `packages/app/src/components/sidebar/ActorsSection.tsx`
- `packages/app/src/components/panel/IdeasView.tsx`
- `packages/app/src/components/panel/ActorsView.tsx`
- Existing tests beside those files, switching mocks from `@/lib/supabase-client` to `@/lib/backend` when the product code no longer imports Supabase directly.
- `apps/daemon/src/backend/mod.rs`
- `apps/daemon/src/backend/mock.rs`
- `apps/daemon/src/supabase/client.rs`
- `apps/daemon/src/runtime/manager.rs`
- `apps/daemon/src/runtime/handle.rs`
- `apps/daemon/src/teamclaw/session_manager.rs`
- `apps/daemon/src/channels/acp_handle.rs`
- `apps/daemon/src/channels/supabase_store.rs`
- `apps/daemon/src/channels/mod.rs`
- `apps/daemon/src/daemon/server.rs`

## Task 1: Add Source-Scan Guardrails

**Files:**

- Create: `packages/app/src/lib/backend/__tests__/supabase-boundary.test.ts`

- [ ] **Step 1: Write the failing source-scan test**

Create `packages/app/src/lib/backend/__tests__/supabase-boundary.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const appSrc = path.resolve(process.cwd(), "src");
const daemonSrc = path.resolve(process.cwd(), "../../apps/daemon/src");
const desktopSrc = path.resolve(process.cwd(), "../../apps/desktop/src");

const appAllowed = [
  "lib/supabase-client.ts",
  "lib/backend/supabase/",
  "lib/backend/__tests__/",
  "components/settings/ServerSection.tsx",
  "components/auth/DesktopOnboarding.tsx",
  "lib/server-config.ts",
];

const daemonAllowed = [
  "supabase/",
  "backend/error.rs",
  "onboarding/init.rs",
  "onboarding/invite_url.rs",
  "main.rs",
];

function walk(dir: string, suffixes: string[]): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, suffixes);
    return suffixes.some((suffix) => full.endsWith(suffix)) ? [full] : [];
  });
}

function rel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

describe("Supabase provider boundary", () => {
  it("keeps Desktop product code from importing the raw Supabase client", () => {
    const offenders = walk(appSrc, [".ts", ".tsx"])
      .filter((file) => !rel(appSrc, file).includes("__tests__/"))
      .filter((file) => !rel(appSrc, file).endsWith(".test.ts"))
      .filter((file) => !rel(appSrc, file).endsWith(".test.tsx"))
      .filter((file) => !appAllowed.some((allowed) => rel(appSrc, file).startsWith(allowed)))
      .filter((file) => fs.readFileSync(file, "utf8").includes("@/lib/supabase-client"))
      .map((file) => rel(appSrc, file));

    expect(offenders).toEqual([]);
  });

  it("keeps daemon REST/RPC Supabase calls inside the Supabase adapter", () => {
    const offenders = walk(daemonSrc, [".rs"])
      .filter((file) => !rel(daemonSrc, file).includes("/tests/"))
      .filter((file) => !daemonAllowed.some((allowed) => rel(daemonSrc, file).startsWith(allowed)))
      .filter((file) => {
        const text = fs.readFileSync(file, "utf8");
        return text.includes("/rest/v1/") || text.includes("SupabaseResult") || text.includes("SupabaseError");
      })
      .map((file) => rel(daemonSrc, file));

    expect(offenders).toEqual([]);
  });

  it("documents that Tauri Rust has no direct Supabase data writes", () => {
    const offenders = walk(desktopSrc, [".rs"])
      .filter((file) => {
        const text = fs.readFileSync(file, "utf8");
        return text.includes("/rest/v1/") || text.includes("SupabaseResult") || text.includes("SupabaseError");
      })
      .map((file) => rel(desktopSrc, file));

    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the guardrail and verify it fails**

Run:

```bash
pnpm --filter @teamclaw/app exec vitest run src/lib/backend/__tests__/supabase-boundary.test.ts
```

Expected: FAIL. The first failure should list current Desktop product files such
as `App.tsx`, `stores/session-messages.ts`, `lib/idea-mutations.ts`, and visible
components that still import `@/lib/supabase-client`.

- [ ] **Step 3: Commit the red guardrail**

```bash
git add packages/app/src/lib/backend/__tests__/supabase-boundary.test.ts
git commit -m "test(app): guard supabase write boundary"
```

## Task 2: Extend Backend Facade Types and Compose Empty Service Slots

**Files:**

- Modify: `packages/app/src/lib/backend/types.ts`
- Modify: `packages/app/src/lib/backend/supabase/index.ts`
- Create: the new Supabase service files listed in File Structure
- Test: `packages/app/src/lib/backend/__tests__/provider.test.ts`

- [ ] **Step 1: Write the failing provider composition assertions**

Extend `packages/app/src/lib/backend/__tests__/provider.test.ts` in the
`defaults to a Supabase backend singleton` test:

```ts
expect(first.teams).toBeDefined();
expect(first.ideas).toBeDefined();
expect(first.actors).toBeDefined();
expect(first.sessionMembers).toBeDefined();
expect(first.shortcuts).toBeDefined();
expect(first.notifications).toBeDefined();
expect(first.teamWorkspaceConfig).toBeDefined();
expect(first.telemetry).toBeDefined();
```

- [ ] **Step 2: Run the provider test and verify it fails**

Run:

```bash
pnpm --filter @teamclaw/app exec vitest run src/lib/backend/__tests__/provider.test.ts
```

Expected: FAIL because `TeamClawBackend` has no new service properties.

- [ ] **Step 3: Add provider-neutral service interfaces**

Append these interfaces to `packages/app/src/lib/backend/types.ts` and add the
properties to `TeamClawBackend`:

```ts
export interface TeamSummary {
  id: string;
  name: string;
  slug?: string | null;
  created_at?: string | null;
}

export interface TeamInviteResult {
  token: string;
  inviteUrl?: string | null;
  actorId?: string | null;
}

export interface TeamsBackend {
  createTeam(input: { name: string }): Promise<TeamSummary>;
  renameTeam(teamId: string, name: string): Promise<TeamSummary>;
  createTeamInvite(input: { teamId: string; actorType?: "member" | "agent"; displayName?: string | null }): Promise<TeamInviteResult>;
  removeTeamActor(actorId: string): Promise<void>;
}

export interface IdeaRow {
  id: string;
  team_id: string;
  title: string;
  body?: string | null;
  status?: string | null;
  created_by_actor_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  archived_at?: string | null;
}

export interface IdeasBackend {
  listIdeas(teamId: string): Promise<IdeaRow[]>;
  getIdeaDetail(ideaId: string): Promise<IdeaRow | null>;
  createIdea(input: { teamId: string; title: string; body?: string | null }): Promise<IdeaRow>;
  updateIdea(input: { ideaId: string; title?: string; body?: string | null; status?: string | null }): Promise<void>;
  archiveIdea(ideaId: string): Promise<void>;
  createIdeaActivity(input: { ideaId: string; actorId: string; eventType: string; metadata?: Record<string, unknown> | null }): Promise<void>;
}

export interface ActorDirectoryEntry {
  id: string;
  team_id: string;
  display_name: string | null;
  actor_type: string | null;
  avatar_url?: string | null;
  user_id?: string | null;
}

export interface ConnectedAgentRow extends ActorDirectoryEntry {
  device_id?: string | null;
  agent_types?: string[] | null;
  default_agent_type?: string | null;
}

export interface ActorsBackend {
  listActorDirectory(teamId: string): Promise<ActorDirectoryEntry[]>;
  listConnectedAgents(teamId: string): Promise<ConnectedAgentRow[]>;
  updateOwnedAgentProfile(input: { agentId: string; displayName?: string | null; avatarUrl?: string | null }): Promise<void>;
  updateAgentDefaults(input: { agentId: string; agentTypes: string[]; defaultAgentType: string }): Promise<void>;
}

export interface SessionMemberCandidate extends ActorDirectoryEntry {
  is_present: boolean;
}

export interface SessionMembersBackend {
  listParticipants(sessionId: string): Promise<ActorDirectoryEntry[]>;
  listCandidateActors(teamId: string, presentActorIds: string[]): Promise<SessionMemberCandidate[]>;
  addParticipant(sessionId: string, actorId: string): Promise<void>;
  removeParticipant(sessionId: string, actorId: string): Promise<void>;
}

export interface ShortcutRow {
  id: string;
  scope: string;
  title: string;
  payload: unknown;
  sort_order?: number | null;
  visible_roles?: string[] | null;
}

export interface ShortcutsBackend {
  listShortcuts(scope: string): Promise<ShortcutRow[]>;
  createShortcut(input: Record<string, unknown>): Promise<ShortcutRow>;
  updateShortcut(id: string, patch: Record<string, unknown>): Promise<void>;
  deleteShortcut(id: string): Promise<void>;
  batchMove(input: { ids: string[]; targetScope: string }): Promise<void>;
  setVisibleRoles(input: { shortcutId: string; roles: string[] }): Promise<void>;
}

export interface NotificationPrefs {
  actor_id: string;
  enabled: boolean;
  updated_at?: string | null;
}

export interface NotificationsBackend {
  loadPreferences(actorId: string): Promise<NotificationPrefs | null>;
  savePreferences(input: NotificationPrefs): Promise<void>;
  setSessionMuted(input: { sessionId: string; actorId: string; muted: boolean }): Promise<void>;
  listMutedSessionIds(actorId: string): Promise<string[]>;
}

export interface TeamWorkspaceConfigRow {
  team_id: string;
  workspace_path?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface TeamWorkspaceConfigBackend {
  load(teamId: string): Promise<TeamWorkspaceConfigRow | null>;
  save(input: TeamWorkspaceConfigRow): Promise<void>;
}

export interface TelemetryBackend {
  insertFeedback(input: Record<string, unknown>): Promise<void>;
  insertSessionReport(input: Record<string, unknown>): Promise<void>;
  insertTelemetryEvent(input: Record<string, unknown>): Promise<void>;
}
```

Add to `TeamClawBackend`:

```ts
teams: TeamsBackend;
ideas: IdeasBackend;
actors: ActorsBackend;
sessionMembers: SessionMembersBackend;
shortcuts: ShortcutsBackend;
notifications: NotificationsBackend;
teamWorkspaceConfig: TeamWorkspaceConfigBackend;
telemetry: TelemetryBackend;
```

- [ ] **Step 4: Create minimal Supabase service files**

Each new file exports a `createSupabase*Backend(client: unknown)` function.
The initial implementation should throw a loud error per method so composition
can compile before adapter methods are filled in. Use this pattern:

```ts
function notImplemented(operation: string): never {
  throw new Error(`${operation} backend not implemented`);
}
```

Example for `packages/app/src/lib/backend/supabase/teams.ts`:

```ts
import type { TeamsBackend } from "../types";

function notImplemented(operation: string): never {
  throw new Error(`${operation} backend not implemented`);
}

export function createSupabaseTeamsBackend(_client: unknown): TeamsBackend {
  return {
    createTeam: async () => notImplemented("teams.createTeam"),
    renameTeam: async () => notImplemented("teams.renameTeam"),
    createTeamInvite: async () => notImplemented("teams.createTeamInvite"),
    removeTeamActor: async () => notImplemented("teams.removeTeamActor"),
  };
}
```

Repeat the same pattern for the remaining new service files using their
interface method names.

- [ ] **Step 5: Compose the new services**

Update `packages/app/src/lib/backend/supabase/index.ts`:

```ts
import { createSupabaseTeamsBackend } from "./teams";
import { createSupabaseIdeasBackend } from "./ideas";
import { createSupabaseActorsBackend } from "./actors";
import { createSupabaseSessionMembersBackend } from "./session-members";
import { createSupabaseShortcutsBackend } from "./shortcuts";
import { createSupabaseNotificationsBackend } from "./notifications";
import { createSupabaseTeamWorkspaceConfigBackend } from "./team-workspace-config";
import { createSupabaseTelemetryBackend } from "./telemetry";
```

Add these properties to the returned object:

```ts
teams: createSupabaseTeamsBackend(supabase),
ideas: createSupabaseIdeasBackend(supabase),
actors: createSupabaseActorsBackend(supabase),
sessionMembers: createSupabaseSessionMembersBackend(supabase),
shortcuts: createSupabaseShortcutsBackend(supabase),
notifications: createSupabaseNotificationsBackend(supabase),
teamWorkspaceConfig: createSupabaseTeamWorkspaceConfigBackend(supabase),
telemetry: createSupabaseTelemetryBackend(supabase),
```

- [ ] **Step 6: Run provider test and typecheck**

```bash
pnpm --filter @teamclaw/app exec vitest run src/lib/backend/__tests__/provider.test.ts
pnpm --filter @teamclaw/app typecheck
```

Expected: provider test PASS; typecheck PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/lib/backend
git commit -m "feat(app): add product backend service slots"
```

## Task 3: Implement Teams, Actors, and Invites Adapter Methods

**Files:**

- Modify: `packages/app/src/lib/backend/supabase/teams.ts`
- Modify: `packages/app/src/lib/backend/supabase/actors.ts`
- Test: `packages/app/src/lib/backend/supabase/__tests__/teams-ideas-actors.test.ts`
- Modify callers: `stores/current-team.ts`, `components/auth/AuthGate.tsx`, `components/settings/team/TeamGitConfig.tsx`, `components/sidebar/InviteActorDialog.tsx`, `components/sidebar/ActorsSection.tsx`, `lib/daemon-agent-admin.ts`, `lib/daemon-workspaces.ts`

- [ ] **Step 1: Write failing adapter tests**

Create `packages/app/src/lib/backend/supabase/__tests__/teams-ideas-actors.test.ts`
with these first tests:

```ts
import { describe, expect, it, vi } from "vitest";
import { createSupabaseTeamsBackend } from "../teams";
import { createSupabaseActorsBackend } from "../actors";

describe("Supabase teams backend", () => {
  it("renames a team through the rename_team RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { id: "team-1", name: "New Team" },
      error: null,
    });

    const result = await createSupabaseTeamsBackend({ rpc }).renameTeam("team-1", "New Team");

    expect(rpc).toHaveBeenCalledWith("rename_team", {
      p_team_id: "team-1",
      p_name: "New Team",
    });
    expect(result).toEqual({ id: "team-1", name: "New Team" });
  });

  it("creates a team invite through create_team_invite", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { token: "tok", invite_url: "teamclaw://invite?token=tok" },
      error: null,
    });

    const result = await createSupabaseTeamsBackend({ rpc }).createTeamInvite({
      teamId: "team-1",
      actorType: "member",
      displayName: "Ada",
    });

    expect(rpc).toHaveBeenCalledWith("create_team_invite", {
      p_team_id: "team-1",
      p_actor_type: "member",
      p_display_name: "Ada",
    });
    expect(result).toEqual({
      token: "tok",
      inviteUrl: "teamclaw://invite?token=tok",
      actorId: null,
    });
  });
});

describe("Supabase actors backend", () => {
  it("updates owned agent profile through update_owned_agent_profile", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });

    await createSupabaseActorsBackend({ rpc }).updateOwnedAgentProfile({
      agentId: "agent-1",
      displayName: "Agent",
      avatarUrl: "https://avatar",
    });

    expect(rpc).toHaveBeenCalledWith("update_owned_agent_profile", {
      p_agent_id: "agent-1",
      p_display_name: "Agent",
      p_avatar_url: "https://avatar",
    });
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

```bash
pnpm --filter @teamclaw/app exec vitest run src/lib/backend/supabase/__tests__/teams-ideas-actors.test.ts
```

Expected: FAIL because methods still throw "backend not implemented".

- [ ] **Step 3: Implement teams and actors methods**

In `teams.ts`, cast `client` to `{ rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown | null }> }`, call the exact RPC names above, and throw `toBackendError(error, "teams.methodName")` on error.

In `actors.ts`, implement:

```ts
listConnectedAgents(teamId) -> rpc("list_connected_agents", { p_team_id: teamId })
updateOwnedAgentProfile(input) -> rpc("update_owned_agent_profile", ...)
updateAgentDefaults(input) -> rpc("update_agent_defaults", ...)
listActorDirectory(teamId) -> from("actors").select(...).eq("team_id", teamId)
```

Use the existing column selections from the direct-call files being migrated.

- [ ] **Step 4: Run adapter tests**

```bash
pnpm --filter @teamclaw/app exec vitest run src/lib/backend/supabase/__tests__/teams-ideas-actors.test.ts
```

Expected: PASS.

- [ ] **Step 5: Migrate callers and tests**

Replace direct Supabase writes with:

```ts
await getBackend().teams.renameTeam(teamId, name);
await getBackend().teams.createTeamInvite({ teamId, actorType, displayName });
await getBackend().teams.removeTeamActor(actorId);
await getBackend().actors.updateOwnedAgentProfile(input);
await getBackend().actors.updateAgentDefaults(input);
```

Switch tests for these files from `@/lib/supabase-client` mocks to
`@/lib/backend` mocks where the production file no longer imports Supabase.

- [ ] **Step 6: Run focused tests**

```bash
pnpm --filter @teamclaw/app exec vitest run \
  src/lib/backend/supabase/__tests__/teams-ideas-actors.test.ts \
  src/stores/auth-store.test.ts \
  src/components/auth/__tests__/AuthGate.test.tsx \
  src/components/sidebar/__tests__
pnpm --filter @teamclaw/app typecheck
```

Expected: all selected tests PASS; typecheck PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/lib/backend packages/app/src/stores/current-team.ts packages/app/src/components/auth packages/app/src/components/sidebar packages/app/src/components/settings/team packages/app/src/lib/daemon-agent-admin.ts packages/app/src/lib/daemon-workspaces.ts
git commit -m "feat(app): route team and actor writes through backend"
```

## Task 4: Implement Ideas Backend and Migrate Ideas UI

**Files:**

- Modify: `packages/app/src/lib/backend/supabase/ideas.ts`
- Test: `packages/app/src/lib/backend/supabase/__tests__/teams-ideas-actors.test.ts`
- Modify: `packages/app/src/lib/idea-mutations.ts`
- Modify: `packages/app/src/components/panel/IdeasView.tsx`
- Modify: `packages/app/src/components/sidebar/CreateIdeaDialog.tsx`
- Modify: `packages/app/src/components/sidebar/IdeaDetailDialog.tsx`
- Modify: `packages/app/src/components/sidebar/IdeasSection.tsx`
- Update related tests.

- [ ] **Step 1: Add failing idea adapter tests**

Append:

```ts
import { createSupabaseIdeasBackend } from "../ideas";

describe("Supabase ideas backend", () => {
  it("creates an idea through create_idea", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { id: "idea-1", team_id: "team-1", title: "Idea", body: "Body" },
      error: null,
    });

    const result = await createSupabaseIdeasBackend({ rpc }).createIdea({
      teamId: "team-1",
      title: "Idea",
      body: "Body",
    });

    expect(rpc).toHaveBeenCalledWith("create_idea", {
      p_team_id: "team-1",
      p_title: "Idea",
      p_body: "Body",
    });
    expect(result.id).toBe("idea-1");
  });

  it("archives an idea through archive_idea", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });

    await createSupabaseIdeasBackend({ rpc }).archiveIdea("idea-1");

    expect(rpc).toHaveBeenCalledWith("archive_idea", { p_idea_id: "idea-1" });
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

```bash
pnpm --filter @teamclaw/app exec vitest run src/lib/backend/supabase/__tests__/teams-ideas-actors.test.ts
```

Expected: FAIL because ideas methods are not implemented.

- [ ] **Step 3: Implement ideas adapter**

Implement `listIdeas`, `getIdeaDetail`, `createIdea`, `updateIdea`,
`archiveIdea`, and `createIdeaActivity` using the exact existing RPC/table calls
from `idea-mutations.ts`, `IdeasView.tsx`, `CreateIdeaDialog.tsx`,
`IdeaDetailDialog.tsx`, and `IdeasSection.tsx`. Normalize null rows to `null`
for `getIdeaDetail` and `[]` for list methods.

- [ ] **Step 4: Run idea adapter tests**

```bash
pnpm --filter @teamclaw/app exec vitest run src/lib/backend/supabase/__tests__/teams-ideas-actors.test.ts
```

Expected: PASS.

- [ ] **Step 5: Migrate ideas callers**

Replace direct Supabase use with:

```ts
const backend = getBackend();
await backend.ideas.createIdea(input);
await backend.ideas.updateIdea(input);
await backend.ideas.archiveIdea(ideaId);
await backend.ideas.createIdeaActivity(input);
const rows = await backend.ideas.listIdeas(teamId);
const idea = await backend.ideas.getIdeaDetail(ideaId);
```

When an ideas component only uses Supabase to resolve current actor/team before
writing, call existing `getBackend().directory.resolveCurrentMemberActor(...)`
or add a narrow `teams`/`actors` method rather than keeping a raw Supabase read.

- [ ] **Step 6: Run focused ideas tests**

```bash
pnpm --filter @teamclaw/app exec vitest run \
  src/lib/__tests__/idea-mutations.test.ts \
  src/components/panel/__tests__/IdeasView.test.tsx \
  src/components/sidebar/__tests__/CreateIdeaDialog.test.tsx \
  src/components/sidebar/__tests__/IdeaDetailDialog.test.tsx
pnpm --filter @teamclaw/app typecheck
```

Expected: all selected tests PASS; typecheck PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/lib/backend packages/app/src/lib/idea-mutations.ts packages/app/src/components/panel/IdeasView.tsx packages/app/src/components/sidebar
git commit -m "feat(app): route ideas through backend"
```

## Task 5: Implement Session Members and Remaining Chat Adjacent Writes

**Files:**

- Modify: `packages/app/src/lib/backend/supabase/session-members.ts`
- Modify: `packages/app/src/lib/backend/supabase/messages.ts`
- Modify: `packages/app/src/lib/backend/supabase/runtime.ts`
- Test: `packages/app/src/lib/backend/supabase/__tests__/product-services.test.ts`
- Modify: `packages/app/src/stores/session-messages.ts`
- Modify: `packages/app/src/components/chat/ActorChatInput.tsx`
- Modify: `packages/app/src/components/chat/SessionActorSheet.tsx`
- Modify: `packages/app/src/components/chat/ChatPanel.tsx`
- Modify: `packages/app/src/components/chat/MentionPopover.tsx`
- Modify: `packages/app/src/components/chat/NewSessionDialog.tsx`
- Modify: `packages/app/src/components/chat/AgentSelectorDock.tsx`
- Modify: `packages/app/src/components/chat/SessionContinueBanner.tsx`

- [ ] **Step 1: Write failing session-member adapter tests**

Create `packages/app/src/lib/backend/supabase/__tests__/product-services.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createSupabaseSessionMembersBackend } from "../session-members";

describe("Supabase session members backend", () => {
  it("removes a participant by session and actor id", async () => {
    const eqActor = vi.fn().mockResolvedValue({ error: null });
    const eqSession = vi.fn().mockReturnValue({ eq: eqActor });
    const deleteMock = vi.fn().mockReturnValue({ eq: eqSession });
    const from = vi.fn().mockReturnValue({ delete: deleteMock });

    await createSupabaseSessionMembersBackend({ from }).removeParticipant("session-1", "actor-1");

    expect(from).toHaveBeenCalledWith("session_participants");
    expect(deleteMock).toHaveBeenCalled();
    expect(eqSession).toHaveBeenCalledWith("session_id", "session-1");
    expect(eqActor).toHaveBeenCalledWith("actor_id", "actor-1");
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

```bash
pnpm --filter @teamclaw/app exec vitest run src/lib/backend/supabase/__tests__/product-services.test.ts
```

Expected: FAIL because session member methods are not implemented.

- [ ] **Step 3: Implement session member methods**

Implement `listParticipants`, `listCandidateActors`, `addParticipant`, and
`removeParticipant` using the existing queries from `SessionActorSheet.tsx`,
`ChatPanel.tsx`, and related helpers. `addParticipant` should insert one
`session_participants` row; `removeParticipant` should delete by
`session_id` and `actor_id`.

- [ ] **Step 4: Run adapter tests**

```bash
pnpm --filter @teamclaw/app exec vitest run src/lib/backend/supabase/__tests__/product-services.test.ts
```

Expected: PASS.

- [ ] **Step 5: Migrate chat/session member callers**

Replace direct Supabase writes and write-adjacent reads:

```ts
await getBackend().messages.insertOutgoingMessage(input);
await getBackend().sessionMembers.addParticipant(sessionId, actorId);
await getBackend().sessionMembers.removeParticipant(sessionId, actorId);
const participants = await getBackend().sessionMembers.listParticipants(sessionId);
const candidates = await getBackend().sessionMembers.listCandidateActors(teamId, presentActorIds);
const agents = await getBackend().actors.listConnectedAgents(teamId);
const runtimeRows = await getBackend().runtime.listLatestAgentRuntimeHints(teamId, agentActorIds);
```

Keep MQTT behavior unchanged.

- [ ] **Step 6: Run focused chat tests**

```bash
pnpm --filter @teamclaw/app exec vitest run \
  src/components/chat/__tests__/SessionActorSheet.test.tsx \
  src/components/chat/__tests__/MentionPopover.test.tsx \
  src/components/chat/__tests__/NewSessionDialog.test.tsx \
  src/components/chat/__tests__/AgentSelectorDock.test.tsx \
  src/stores/session-message-store.test.ts \
  src/stores/session-store.test.ts \
  src/stores/__tests__/session-daemon-send.test.ts
pnpm --filter @teamclaw/app typecheck
```

Expected: all selected tests PASS; typecheck PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/lib/backend packages/app/src/stores/session-messages.ts packages/app/src/components/chat
git commit -m "feat(app): route chat collaboration writes through backend"
```

## Task 6: Implement Shortcuts, Notifications, Workspace Config, and Telemetry

**Files:**

- Modify: `packages/app/src/lib/backend/supabase/shortcuts.ts`
- Modify: `packages/app/src/lib/backend/supabase/notifications.ts`
- Modify: `packages/app/src/lib/backend/supabase/team-workspace-config.ts`
- Modify: `packages/app/src/lib/backend/supabase/telemetry.ts`
- Test: `packages/app/src/lib/backend/supabase/__tests__/product-services.test.ts`
- Modify: `packages/app/src/lib/shortcuts-rpc.ts`
- Modify: `packages/app/src/lib/notifications/preferences.ts`
- Modify: `packages/app/src/lib/team-workspace-config.ts`
- Modify: `packages/app/src/stores/telemetry.ts`
- Modify: `packages/app/src/lib/telemetry/supabase-feedback.ts`
- Modify: `packages/app/src/lib/telemetry/supabase-session-report.ts`

- [ ] **Step 1: Add failing product-service adapter tests**

Append to `product-services.test.ts`:

```ts
import { createSupabaseShortcutsBackend } from "../shortcuts";
import { createSupabaseNotificationsBackend } from "../notifications";
import { createSupabaseTeamWorkspaceConfigBackend } from "../team-workspace-config";
import { createSupabaseTelemetryBackend } from "../telemetry";

describe("Supabase shortcuts backend", () => {
  it("creates shortcuts through shortcut_create", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: "shortcut-1", scope: "team", title: "Run", payload: {} }, error: null });
    const result = await createSupabaseShortcutsBackend({ rpc }).createShortcut({ scope: "team", title: "Run", payload: {} });
    expect(rpc).toHaveBeenCalledWith("shortcut_create", { scope: "team", title: "Run", payload: {} });
    expect(result.id).toBe("shortcut-1");
  });
});

describe("Supabase notifications backend", () => {
  it("mutes and unmutes sessions with session_mutes", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const deleteEqActor = vi.fn().mockResolvedValue({ error: null });
    const deleteEqSession = vi.fn().mockReturnValue({ eq: deleteEqActor });
    const from = vi.fn((table: string) => {
      if (table === "session_mutes") {
        return {
          upsert,
          delete: () => ({ eq: deleteEqSession }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    });

    const backend = createSupabaseNotificationsBackend({ from });
    await backend.setSessionMuted({ sessionId: "s1", actorId: "a1", muted: true });
    await backend.setSessionMuted({ sessionId: "s1", actorId: "a1", muted: false });

    expect(upsert).toHaveBeenCalledWith({ session_id: "s1", actor_id: "a1" });
    expect(deleteEqSession).toHaveBeenCalledWith("session_id", "s1");
    expect(deleteEqActor).toHaveBeenCalledWith("actor_id", "a1");
  });
});

describe("Supabase telemetry backend", () => {
  it("inserts feedback rows", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn().mockReturnValue({ insert });
    await createSupabaseTelemetryBackend({ from }).insertFeedback({ message_id: "m1", rating: 1 });
    expect(from).toHaveBeenCalledWith("actor_message_feedback");
    expect(insert).toHaveBeenCalledWith({ message_id: "m1", rating: 1 });
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

```bash
pnpm --filter @teamclaw/app exec vitest run src/lib/backend/supabase/__tests__/product-services.test.ts
```

Expected: FAIL because services are not implemented.

- [ ] **Step 3: Implement adapters**

Use existing table/RPC shapes from the migrated helper files:

- `shortcuts.ts`: existing `shortcuts-rpc.ts` RPC/table calls.
- `notifications.ts`: existing `preferences.ts` table calls.
- `team-workspace-config.ts`: existing `team-workspace-config.ts` load/upsert.
- `telemetry.ts`: existing telemetry table inserts and store writes.

Each method throws `toBackendError(error, "service.method")` on error.

- [ ] **Step 4: Run adapter tests**

```bash
pnpm --filter @teamclaw/app exec vitest run src/lib/backend/supabase/__tests__/product-services.test.ts
```

Expected: PASS.

- [ ] **Step 5: Migrate utilities and background writers**

Replace raw Supabase calls with:

```ts
await getBackend().shortcuts.createShortcut(input);
await getBackend().shortcuts.updateShortcut(id, patch);
await getBackend().shortcuts.deleteShortcut(id);
await getBackend().shortcuts.batchMove(input);
await getBackend().shortcuts.setVisibleRoles(input);
await getBackend().notifications.savePreferences(input);
await getBackend().notifications.setSessionMuted(input);
await getBackend().teamWorkspaceConfig.save(input);
await getBackend().telemetry.insertFeedback(input);
await getBackend().telemetry.insertSessionReport(input);
await getBackend().telemetry.insertTelemetryEvent(input);
```

- [ ] **Step 6: Run focused utility tests**

```bash
pnpm --filter @teamclaw/app exec vitest run \
  src/lib/__tests__/shortcuts-rpc.test.ts \
  src/stores/__tests__/telemetry-consent.test.ts \
  src/__tests__/supabase-feedback.test.ts
pnpm --filter @teamclaw/app typecheck
```

Expected: all selected tests PASS; typecheck PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/lib/backend packages/app/src/lib/shortcuts-rpc.ts packages/app/src/lib/notifications packages/app/src/lib/team-workspace-config.ts packages/app/src/stores/telemetry.ts packages/app/src/lib/telemetry
git commit -m "feat(app): route utility writes through backend"
```

## Task 7: Make the App Guardrail Green

**Files:**

- Modify remaining Product files reported by `supabase-boundary.test.ts`.
- Modify tests that still mock `@/lib/supabase-client` only because product code used it.

- [ ] **Step 1: Run the guardrail and capture current offenders**

```bash
pnpm --filter @teamclaw/app exec vitest run src/lib/backend/__tests__/supabase-boundary.test.ts
```

Expected: FAIL until every disallowed Desktop import and daemon leakage is migrated.

- [ ] **Step 2: Remove remaining Desktop raw Supabase imports**

For each offender in `packages/app/src`, replace direct import:

```ts
import { supabase } from "@/lib/supabase-client";
```

with:

```ts
import { getBackend } from "@/lib/backend";
```

Use an existing domain method when available. If a required operation is missing
and belongs to a migrated workflow, add it to the relevant service and write an
adapter test before changing the caller.

- [ ] **Step 3: Run the guardrail until the app section passes**

```bash
pnpm --filter @teamclaw/app exec vitest run src/lib/backend/__tests__/supabase-boundary.test.ts
```

Expected: app import assertion PASS. Daemon assertion may still fail until Task 8.

- [ ] **Step 4: Run broad app verification**

```bash
pnpm --filter @teamclaw/app exec vitest run src/lib/backend src/lib/__tests__ src/stores src/components/chat src/components/sidebar src/components/panel
pnpm --filter @teamclaw/app typecheck
```

Expected: all selected tests PASS; typecheck PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src
git commit -m "refactor(app): satisfy supabase boundary guardrail"
```

## Task 8: Neutralize Daemon Business Names and DTOs

**Files:**

- Create: `apps/daemon/src/backend/records.rs`
- Modify: `apps/daemon/src/backend/mod.rs`
- Modify: `apps/daemon/src/backend/mock.rs`
- Modify: `apps/daemon/src/supabase/client.rs`
- Modify: `apps/daemon/src/runtime/manager.rs`
- Modify: `apps/daemon/src/runtime/handle.rs`
- Modify: `apps/daemon/src/teamclaw/session_manager.rs`
- Modify: `apps/daemon/src/channels/acp_handle.rs`
- Modify: `apps/daemon/src/channels/supabase_store.rs`
- Modify: `apps/daemon/src/channels/mod.rs`
- Modify: `apps/daemon/src/daemon/server.rs`

- [ ] **Step 1: Write failing daemon DTO tests**

Add tests in `apps/daemon/src/backend/mock.rs`:

```rust
#[test]
fn backend_session_records_are_provider_neutral() {
    use crate::backend::{BackendParticipantRow, BackendSessionRow};

    let session = BackendSessionRow {
        id: "session-1".into(),
        team_id: "team-1".into(),
        created_by_actor_id: Some("member-1".into()),
        primary_agent_id: None,
        mode: "collab".into(),
        title: "Title".into(),
        summary: String::new(),
        idea_id: None,
        created_at: chrono::Utc::now(),
    };
    let participant = BackendParticipantRow {
        session_id: "session-1".into(),
        actor_id: "member-1".into(),
        role: Some("owner".into()),
        joined_at: chrono::Utc::now(),
    };

    assert_eq!(session.id, participant.session_id);
}
```

- [ ] **Step 2: Run daemon backend tests and verify failure**

```bash
cargo test -p amuxd backend_session_records_are_provider_neutral
```

Expected: FAIL because `BackendSessionRow` and `BackendParticipantRow` do not exist.

- [ ] **Step 3: Add provider-neutral daemon records**

Create `apps/daemon/src/backend/records.rs`:

```rust
#[derive(Debug, Clone, serde::Deserialize)]
pub struct BackendSessionRow {
    pub id: String,
    pub team_id: String,
    #[serde(default)]
    pub created_by_actor_id: Option<String>,
    #[serde(default)]
    pub primary_agent_id: Option<String>,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub idea_id: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct BackendParticipantRow {
    pub session_id: String,
    pub actor_id: String,
    #[serde(default)]
    pub role: Option<String>,
    pub joined_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone)]
pub struct BackendSessionAndParticipants {
    pub session: BackendSessionRow,
    pub participants: Vec<BackendParticipantRow>,
}
```

Export from `apps/daemon/src/backend/mod.rs`:

```rust
pub mod records;
pub use records::{BackendParticipantRow, BackendSessionAndParticipants, BackendSessionRow};
```

- [ ] **Step 4: Map Supabase rows to backend rows**

In `apps/daemon/src/supabase/client.rs`, replace exported
`SupabaseSessionRow`, `SupabaseParticipantRow`, and
`SessionAndParticipants` business usage with the backend record types. Keep
internal Supabase-specific names private if needed for deserialization.

The `Backend` trait method:

```rust
async fn fetch_session_with_participants(
    &self,
    session_id: &str,
) -> BackendResult<BackendSessionAndParticipants>;
```

- [ ] **Step 5: Rename business variables and fields**

Use provider-neutral names where the value is `Arc<dyn Backend>`:

- `supabase` field in `DaemonServer`, `RuntimeManager`, `AcpHandle` becomes `backend`.
- `supabase_runtime_row_id` becomes `backend_runtime_row_id`.
- `supabase_workspace_id` becomes `remote_workspace_id`.
- `supabase_session_id` becomes `remote_session_id`.
- `insert_session_from_supabase` becomes `insert_session_from_backend`.

Keep `SupabaseBackend`, `SupabaseConfig`, and `apps/daemon/src/supabase/**`
names unchanged.

- [ ] **Step 6: Run daemon tests**

```bash
cargo test -p amuxd backend_session_records_are_provider_neutral
cargo test -p amuxd backend
cargo test -p amuxd
```

Expected: all selected daemon tests PASS.

- [ ] **Step 7: Run source guardrail**

```bash
pnpm --filter @teamclaw/app exec vitest run src/lib/backend/__tests__/supabase-boundary.test.ts
```

Expected: daemon assertion PASS. If it reports a business file, either migrate
the reference to provider-neutral DTOs or add a narrow allowlist entry only when
the reference is boot/onboarding provider construction.

- [ ] **Step 8: Commit**

```bash
git add apps/daemon/src packages/app/src/lib/backend/__tests__/supabase-boundary.test.ts
git commit -m "refactor(daemon): neutralize supabase business boundary"
```

## Task 9: Final Verification and Preview Integration

**Files:**

- No production edits unless verification exposes a bug.

- [ ] **Step 1: Run final app guardrail and tests**

```bash
pnpm --filter @teamclaw/app exec vitest run \
  src/lib/backend/__tests__/supabase-boundary.test.ts \
  src/lib/backend \
  src/lib/__tests__ \
  src/stores \
  src/components/chat \
  src/components/sidebar \
  src/components/panel
```

Expected: all selected tests PASS.

- [ ] **Step 2: Run typecheck**

```bash
pnpm --filter @teamclaw/app typecheck
```

Expected: PASS.

- [ ] **Step 3: Run daemon tests**

```bash
cargo test -p amuxd backend
cargo test -p amuxd
```

Expected: PASS, with existing warnings allowed unless caused by this work.

- [ ] **Step 4: Check diff hygiene**

```bash
git diff --check agent/preview-integration...HEAD
git status --short --branch
```

Expected: no whitespace errors; worktree clean after commits.

- [ ] **Step 5: Patch into preview-integration**

From the stable repo root:

```bash
git diff --binary agent/preview-integration..agent/desktop-daemon-supabase-write-boundary --output=/private/tmp/tauri-daemon-supabase-write-boundary.patch
git -C .worktrees/preview-integration apply --check /private/tmp/tauri-daemon-supabase-write-boundary.patch
git -C .worktrees/preview-integration apply /private/tmp/tauri-daemon-supabase-write-boundary.patch
git -C .worktrees/preview-integration add -A
git -C .worktrees/preview-integration commit -m "wip: integrate tauri daemon supabase write boundary"
```

- [ ] **Step 6: Run preview verification**

```bash
pnpm --filter @teamclaw/app exec vitest run src/lib/backend/__tests__/supabase-boundary.test.ts src/lib/backend
pnpm --filter @teamclaw/app typecheck
cargo test -p amuxd backend
```

Expected: all PASS.

- [ ] **Step 7: Report and stop before PR**

Report:

- candidate branch name
- preview integration commit hash
- tests run
- known residual Supabase references that are allowed by the spec

Do not push or create a PR until the user explicitly says to open the PR.
