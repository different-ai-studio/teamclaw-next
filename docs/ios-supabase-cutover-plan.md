# iOS Supabase → Cloud API Cutover: Master Execution Plan

## 0. Locked Decisions (2026-05-30)

1. **Attachment URL strategy = REWRITE.** No presign endpoint. Use a bearer-gated
   download via `CloudAPIClient`, and rewrite every `AsyncImage(url:)` call-site to
   fetch bytes through the authenticated client and render from `Data`. Upload goes
   through a raw-binary `CloudAPIClient` helper + the FC upload route.
2. **Auth = delete now, ignore history. NO migration window.** Drop
   `SupabaseSessionBridge` / `legacyRefreshToken()` in the same pass that removes the
   SDK. Existing users whose session lives only in the Supabase keychain WILL be
   signed out and must re-auth — accepted. Collapses the old 7a/7b split into one batch.
3. **Session-create per-participant roles = DROPPED.** Use FC's flat
   `participantActorIds[]`; do not preserve per-participant role metadata.

---

## 1. Executive Summary

**Total domains: 10** (9 distinct repo/feature domains + 1 cross-cutting Auth/foundation domain that overlaps Onboarding + Push).

| Status | Count | Domains |
|---|---|---|
| **Already migrated** (CloudAPI impl exists, only rewiring/cleanup) | 2 | Onboarding store, Teams residual |
| **Pure-iOS** (FC endpoint exists end-to-end, no backend change) | 3 | Workspaces, Shortcuts, Session write/participants |
| **Need backend (FC + OpenAPI) work** | 5 | Actors, AgentAccess, Ideas, Push/Notifications, Attachments |

**Pure-iOS vs backend-required: 5 pure-iOS / cleanup vs 5 requiring FC work.**

### Hard blockers (no iOS cutover possible until built in FC)
1. **Attachments presign** — `attachments` bucket is private; iOS depends on a tokenless 1-yr signed URL persisted into message content and rendered by plain `AsyncImage`. FC only returns a public-object URL (403s on private bucket) or a bearer-gated download. **No presign endpoint exists.** Plus `CloudAPIClient` is JSON-only (no raw binary up/download).
2. **Device push-token registration** — no `/v1` route writes `device_push_tokens`. Without it, push delivery silently breaks after cutover.
3. **AgentAccess**: two RPCs (`share_agent_to_team`, `make_agent_personal`) have **zero** Cloud API surface; and the `ConnectedAgent` shape drops `permissionLevel/visibility/isOwner` (RPC returns them, FC mapper discards them).
4. **Ideas**: two ops have **no endpoint** (`reorderIdeas`, `GET listIdeaActivities`); FC `Idea`/`IdeaActivity` responses drop fields iOS hard-depends on (`status`, `sortOrder`, `workspaceId`, `createdByActorId`; `teamId`, `updatedAt`, `attachmentUrls`); archive is one-directional.
5. **Auth migration window**: deleting `SupabaseSessionBridge.legacyRefreshToken()` in the same release that drops `supabase-swift` **silently signs out every existing user**. The bridge must ship and run for ≥1 release BEFORE SDK removal.

### Soft (non-blocking) realities
- `CloudAPIClient` has only `get/post/postVoid` — needs `deleteVoid`, `put`/`putVoid`, and raw binary helpers added incrementally.
- OpenAPI is stale in ≥6 places (Actor, AgentDefaultsPatch, createTeamInvite, NotificationPrefs, Idea/IdeaActivity, SessionParticipant, Shortcut, Workspace) — runtime FC handlers already return more than documented. Doc-only fixes, verify against handler code not YAML.
- `SupabaseProjectConfiguration` / `SupabaseServerStore` / `SignUpOutcome` live inside `SupabaseAppOnboardingStore.swift` and are shared by ~8 repos + push wiring — relocate to a Supabase-free file early.

---

## 2. Dependency-Ordered PR Batches

Ordering principle: build shared transport primitives first → bank low-risk pure-iOS wins → tackle backend-heavy domains in parallel-friendly groups → isolate Attachments and Auth/SDK-removal last.

### Batch 0 — Shared infra primitives (prereq for everything)
**Size: S.** No domain cutover, pure plumbing. Unblocks all later batches.
- Add `deleteVoid(path:)`, `putVoid`/`put`, raw `postRaw(path:bytes:contentType:)` + `getRaw(path:) -> (Data, mime)` to `CloudAPIClient.swift`.
- Relocate `SupabaseProjectConfiguration`, `SupabaseServerStore`, `SignUpOutcome` out of `SupabaseAppOnboardingStore.swift` into a Supabase-free file (e.g. `AuthErrors.swift` / a CloudAPI config helper).
- Add `teamRepo`, `sessionRepo`, `ideasRepo`, `workspacesRepo` (as needed) slots to `TeamRuntimeContext.swift` ahead of consumers.

### Batch 1 — Pure-iOS low-risk CRUD (group together)
**Size: M. Domains: Workspaces, Shortcuts, Teams residual.** All three are read-mostly, FC endpoints exist end-to-end, CloudAPI factory pattern already proven. Teams residual already has `CloudAPITeamRepository` + factory. Grouping maximizes one-PR throughput with minimal risk.
- Why first: zero backend dependency, exercises the injection plumbing (TeamRuntimeContext threading into AMUXUI sheets) that later batches reuse.

### Batch 2 — Session write/participants
**Size: M (medium risk).** Pure-iOS (FC endpoints exist) but write-path semantics: `addParticipants` is N→1 loop, `createSession` field mapping (`primaryAgentActorId`, no `summary`, roles dropped), needs `deleteVoid`. Isolated from Batch 1 because it touches `SessionDetailViewModel` fallbacks at 6 sites.

### Batch 3 — Ideas (backend-heavy)
**Size: L. High risk.** Self-contained FC work: 2 new endpoints (reorder, GET activities), field additions to Idea/IdeaActivity, un-archive support. Single iOS consumer (`IdeasTab`). Can run in parallel with Batch 4 (disjoint FC files mostly in `ideas.mjs`).

### Batch 4 — Actors + AgentAccess (backend-heavy, share `actors.mjs`)
**Size: XL. High risk.** Grouped because both touch `services/fc/lib/routes/actors.mjs`, `supabase-repo.mjs`, and the same OpenAPI Actor/ConnectedAgent schemas — coordinating avoids merge churn. Includes the largest backend gaps short of Attachments (member self-profile, avatar presign overlap, share-to-team/make-personal RPCs, ConnectedAgent shape fix).

### Batch 5 — Push/Notifications
**Size: L. High risk.** Needs the device-token FC endpoint (blocker) + CloudAPI push adapters + `CloudAPIClient` PUT/DELETE (from Batch 0). Touches app bootstrap (`AMUXApp.swift`, `PushBootstrap.swift`). Kept separate so push regressions are isolated.

### Batch 6 — Attachments / Storage
**Size: L. High risk, isolated.** The presign blocker + raw-binary transport. Touch a concrete class (`AttachmentUploadManager`) and 4 AMUXUI views via the `fromMainBundle` chokepoint. Isolated entirely because the URL-in-message-content model is fragile and cross-client.

### Batch 7 — Auth/SDK-removal endgame (TWO releases)
**Size: M, but gated by a release window.**
- **7a (ship first):** Onboarding-store cleanup — drop the Supabase fallback branch in `ContentView`, decouple `CloudAPIConfiguration` from `supabaseURL/anonKey`, keep `SupabaseSessionBridge` + `legacyRefreshToken()` running for migration. SDK still present.
- **7b (follow-up release ONLY after 7a is in users' hands):** delete `SupabaseSessionBridge`, all `Supabase*Repository.swift`, `SupabaseAppOnboardingStore.swift`, `SupabasePushAdapters.swift`; remove `import Supabase` everywhere; drop `supabase-swift` from `Package.swift`; expand the guardrail test to all of AMUXCore/AMUXApp/AMUXUI.

---

## 3. Per-Domain Checklists

### Workspaces — `riskLevel: low` (pure-iOS)
- **New:** Add `CloudAPIWorkspaceRepository` actor + `CloudWorkspace` DTO + `CloudAPIRepositoryFactory.workspacesRepository(configuration:accessToken:)` into `CloudAPI/CloudAPIRepositories.swift` (prefer extending over new file).
- **Endpoint:** `GET /v1/workspaces?teamId={id}[&agentId={id}]&limit=200` → `CloudPage<CloudWorkspace>`. camelCase keys (`teamId/agentId`), `path` nullable → map nil to `""`, `displayName = name`. URL-encode IDs.
- **Rewire consumers (all currently build Supabase inline):**
  - `Onboarding/AppOnboardingCoordinator.swift:239` — build `cloudAPIWorkspacesRepo` near :223-227, fallback `?? (try? SupabaseWorkspaceRepository())`; already feeds `TeamRuntimeContext.workspacesRepo`.
  - `AMUXUI/SessionList/NewSessionSheet.swift:188` — inject repo via init, drop inline.
  - `AMUXUI/AgentDetail/AddAgentSheet.swift:104` — inject via init.
  - `AMUXUI/Members/MemberListContent.swift:741` — inject (separate from the AgentAccessRepository at :733).
  - `ViewModels/SessionDetailViewModel.swift:989` — add `workspacesRepository` init param; use in `resolveWorkspacePath()`.
- **Backend gaps:** none blocking. Doc-only: add `path`/`agentId` to OpenAPI Workspace schema (`yaml:3594-3626`) + `agentId` param to listWorkspaces (`yaml:923-940`).

### Shortcuts — `riskLevel: low` (pure-iOS)
- **New:** `CloudAPIShortcutsRepository` actor + `CloudShortcut` DTO (snake_case→camelCase CodingKeys) + `CloudAPIRepositoryFactory.shortcutsRepository(...)`.
- **Endpoints:** `GET /v1/shortcuts?scope=personal`; `GET /v1/teams/{teamID}/shortcuts` (or `?scope=team&teamId=`). Both return `{items:[...]}`, FC `mapShortcutRow` matches iOS shape. Decode dates as optional → `parseCloudDate(...) ?? .distantPast`.
- **Rewire:** `AppOnboardingCoordinator.swift:196` — replace `try? SupabaseShortcutsRepository()` with factory build (no fallback needed once Supabase removed).
- **Backend gaps:** none. Doc-only: OpenAPI Shortcut schema (`yaml:3855`) is stale.

### Teams residual — `riskLevel: low` (CloudAPI impl already exists)
- **New:** none. `CloudAPITeamRepository` + `CloudAPIRepositoryFactory.teamRepository` already exist (`CloudAPIRepositories.swift:3-20, :196-201`).
- **Rewire:** `AMUXUI/Settings/SettingsView.swift:467` — replace `try SupabaseTeamRepository()` with injected/coordinator-provided `TeamRepository` (Option A: via `TeamRuntimeContext.teamRepo`).
- **Critical cleanup:** `protocol TeamRepository` + `struct TeamDetails` currently live INSIDE `SupabaseTeamRepository.swift` — relocate to a Supabase-free `Teams/TeamRepository.swift` before deleting.
- **Backend gaps:** optional/cosmetic — `ownerDisplayName` drops to nil (Settings "Owner" row → "—"). Add owner field to FC Team schema only if preserving that row.

### Session write/participants — `riskLevel: medium` (pure-iOS)
- **New:** `CloudAPISessionRepository` actor (or in `CloudAPIRepositories.swift`) + DTOs `CloudSessionCreateRequest`, `CloudUpsertParticipantRequest`, `CloudSessionParticipant(+List)` + `CloudAPIRepositoryFactory.sessionRepository(...)`.
- **Edits:** add `deleteVoid(path:)` to `CloudAPIClient.swift` (Batch 0); add `sessionRepo: (any SessionRepository)?` to `TeamRuntimeContext.swift`.
- **Endpoints:**
  - `createSession` → `POST /v1/sessions` map to `{id,teamId,title,mode,ideaId,primaryAgentActorId,participantActorIds}`. **`primaryAgentActorId` not `primaryAgentId`; no `summary` (sent as first message); per-participant roles dropped; `createdBy` server-derived.**
  - `addParticipants` → loop `POST /v1/sessions/:id/participants` (single-actor, idempotent upsert; partial-failure semantics change).
  - `listSessionParticipants` → `GET .../participants`; synthesize `id = "sessionID:actorID"`; decode `displayName/actorType` as optional (FC returns them; OpenAPI omits).
  - `removeParticipant` → `DELETE .../participants/:actorId` (204).
- **Rewire:** `NewSessionSheet.swift:466`, `Collab/InviteSheet.swift:80`, `SessionDetailViewModel.swift:563,778,803,874,1135,1138` (replace `?? (try? SupabaseSessionRepository())` fallbacks).
- **Backend gaps:** doc-only — extend OpenAPI SessionParticipant schema with `displayName/actorType/avatarUrl`.

### Ideas — `riskLevel: high` (heavy backend)
- **New iOS:** `Ideas/CloudAPIIdeaRepository.swift` + `CloudAPIRepositoryFactory.ideasRepository(configuration:accessToken:memberActorID:)` + DTOs.
- **iOS edits:** `TeamRuntimeContext.swift` (add `ideasRepo`); `AppOnboardingCoordinator.swift` (build ~207-241); `AMUXUI/Root/IdeasTab.swift` (inject repo + memberActorID, use in `configureIdeaStore` ~162-190); `AMUXUI/Root/RootTabView.swift:85-93` (thread `teamRuntime?.ideasRepo`).
- **iOS behavior:** `listIdeas` must follow `nextCursor` to exhaustion AND call twice (`archived=false` + `archived=true`); thread `memberActorID` into `createIdea`/`createIdeaActivity` (FC requires `authorActorId`/`actorId`); decode activity `metadata` tolerantly.
- **Backend gaps (FC + OpenAPI + repository-contract + supabase-repo):**
  1. Add `GET /v1/ideas/:ideaId/activities` (list).
  2. Add reorder endpoint `POST /v1/ideas/reorder {teamId, ideaIds}` → `reorder_ideas` RPC.
  3. Extend `mapIdeaRow` (`supabase-repo.mjs:2292`) + OpenAPI Idea (`3974`) with `workspaceId, status, sortOrder, createdByActorId`.
  4. Support un-archive: `POST /v1/ideas/:ideaId/archive` accept `{archived:bool}` (currently hardcodes true); return updated Idea or have iOS re-GET.
  5. Extend `mapIdeaActivityRow` (`2343`) + OpenAPI (`4121`) with `teamId, updatedAt, attachmentUrls`.
  6. Doc `status`/`workspaceId` in OpenAPI IdeaUpdate (`4095`).
  7. Verify RLS attributes creator correctly with client-supplied `authorActorId`.

### Actors — `riskLevel: high` (heavy backend)
- **New iOS:** `CloudAPI/CloudAPIActorRepository.swift` (rich camelCase Actor decode structs) + `CloudAPIRepositoryFactory.actorRepository(...)`.
- **iOS edits:** `AppOnboardingCoordinator.swift:178` (factory instead of `try? SupabaseActorRepository()`); `AMUXUI/Settings/SettingsView.swift:636` (inject ActorRepository — blocked until profile+avatar FC exist); `Actors/ActorRepository.swift` (widen `removeActor` to take `teamID` if using team-scoped DELETE).
- **Endpoints (exist):** `listActors`→`GET /v1/teams/{id}/actors`; `createInvite`→`POST /v1/teams/{id}/invites` (returns `{token,expiresAt,deeplink}`); `claimInvite`→`POST /v1/invites/claim` (delegate to `CloudAPIInviteClaimer`); `heartbeat`→`POST /v1/heartbeat`; `removeActor`→`DELETE /v1/teams/{id}/actors/{actorId}`; `updateAgentDefaults`→`PATCH /v1/agents/{id}/defaults`.
- **Backend gaps:**
  1. **MISSING:** member self-profile — add `PATCH /v1/actors/{actorId}/profile` → RPC `update_current_actor_profile`, return full Actor row. (existing `PATCH /v1/agents/{id}` is agent-only).
  2. **MISSING:** avatar upload — add `POST /v1/actors/{actorId}/avatar/upload-url` returning presigned PUT + public URL (overlaps Attachments presign work).
  3. `PATCH /v1/agents/{id}/defaults` returns 204; iOS needs the row back — either FC returns updated defaults or iOS rebuilds from inputs.
  4. Add `invitedByActorId` + `agentKind` to `mapDirectoryActor` (`supabase-repo.mjs:1899`) + select list.
  5. Fix stale OpenAPI: Actor schema (`3662`), AgentDefaultsPatch (`3727` add `defaultWorkspaceId`+`agentKind`), createTeamInvite (`196/234` add `agentKind/ttlSeconds/targetActorId` + `deeplink`).
  6. `removeActor` signature has no teamID — decide widen-protocol vs unscoped FC route.
- **Note:** `SupabaseAppOnboardingStore.swift:352` also calls `claim_team_invite` independently (Auth domain).

### AgentAccess — `riskLevel: high` (heavy backend)
- **New iOS:** `CloudAPI/CloudAPIAgentAccessRepository.swift` + factory.
- **iOS edits:** `AppOnboardingCoordinator.swift:179` (build via factory, inject into `ConnectedAgentsStore` + `TeamRuntimeContext.agentAccessRepo` — already typed correctly); `TeamclawService.swift:1336` (`rpcTargetDeviceID` — use injected repo or resolve from loaded `ConnectedAgentsStore`); `AMUXUI/Members/MemberListContent.swift:733` (inject instead of `try? Supabase...`).
- **Endpoints (exist):** `listConnectedAgents`→`GET /v1/teams/:teamId/agents/connected`; `listAuthorizedHumans`→`GET /v1/agents/:id/access`; `grantAuthorizedHuman`→`POST /v1/agents/:id/access`; current-member→folded into RPC (drop iOS round-trip).
- **Backend gaps:**
  1. **NEW:** `POST /v1/agents/:id/share-to-team` (204) → `share_agent_to_team` RPC (zero FC surface today).
  2. **NEW:** `POST /v1/agents/:id/make-personal` (204) → `make_agent_personal` RPC (zero FC surface).
  3. **ConnectedAgent shape:** `listConnectedAgents` mapper (`supabase-repo.mjs:1692-1713`) must forward `permission_level, visibility, is_owner` (RPC already returns them); OpenAPI ConnectedAgent (`3698`) add `permissionLevel, visibility, isOwner, agentTypes[]`.
  4. `listAgentAccess` must add `lastActiveAt` + actor `kind/actorType` (iOS filters to `member`); expand OpenAPI AgentAccess (`3736`).
  5. `grantAgentAccess` should set `granted_by_member_id` server-side from bearer.
  6. `canManageAuthorizedHumans` → derive from `ConnectedAgent.isOwner` (not `checkAgentPermission`, since admin≠owner).
  7. `deviceID(for:)` → reuse loaded connected-agents list (no single-agent GET).
- **Auth:** all current-member resolution moves server-side (FC RPCs use `app.current_actor_id_for_team`); verify FC forwards caller bearer.

### Push/Notifications — `riskLevel: high` (heavy backend)
- **New iOS:** `Push/CloudAPIPushAdapters.swift` — `CloudAPIPushTokenUploader`, `CloudAPIPushPreferences`, `CloudAPIPresenceWriter` + factory methods.
- **iOS edits:** `CloudAPIClient.swift` (PUT/DELETE/getVoid — Batch 0); `AMUXApp/PushBootstrap.swift` (replace `registerWithSupabase` → `registerWithCloudAPI`, drop `import Supabase`); `AMUXApp/AMUXApp.swift:56-67` (drop SupabaseClient build, wire `CloudAPIClient`; remove `import Supabase` at :6); `ContentView.swift:94` no protocol change.
- **Endpoints (exist):** presence→`POST /v1/presence/foreground` (drop client `user_id`, camelCase); prefs load/save→`GET`/`PUT|POST /v1/notifications/prefs` (decode REAL snake_case shape, not stale OpenAPI; tolerate null→default); mute→`POST`/`DELETE /v1/sessions/:id/mute`; isMuted→`GET /v1/sessions/muted` + membership test.
- **Backend gaps:**
  1. **CRITICAL/BLOCKER:** add device-token endpoint `POST /v1/devices/push-token` (body `{deviceId, platform, provider, token, appVersion}`; `user_id` from bearer; upsert onConflict `user_id,device_id,provider`) + repository-contract + supabase-repo + OpenAPI.
  2. Fix OpenAPI NotificationPrefs (`3841`) to real snake_case shape.
  3. `putNotificationPrefs` should derive `user_id` from bearer (currently from body).
- **Note:** presence beats every 20s → ensure accessToken closure is cached/cheap.

### Attachments/Storage — `riskLevel: high` (heavy backend, isolated)
- **New iOS:** `CloudAPI/CloudAPIStorageRepository.swift` (`upload(path,mime,bytes)->{path,signedUrl}`, `download(path)->Data`).
- **iOS edits:** `CloudAPIClient.swift` (raw octet-stream upload + raw binary download — Batch 0); `CloudAPIRepositories.swift` (`storageRepository` factory); `Attachments/AttachmentUploadManager.swift` (replace SupabaseClient member + `performUpload`/`createSignedURL`; rewrite `fromMainBundle(modelContext:)` chokepoint to build `CloudAPIClient`; remove `import Supabase`). 4 AMUXUI consumers pass-through via `fromMainBundle` — no change if signature preserved (`SessionComposer.swift:358`, `IdeaDetailView.swift:627`, `IdeaSheet.swift:344`, `AttachmentDrawerSheet.swift:9`).
- **Backend gaps:**
  1. **BLOCKER — presign:** add presign capability (e.g. `POST /v1/attachments:sign` or extend `uploadAttachment` to return `createSignedUrl(path, expiresIn≈1yr)`) for the PRIVATE `attachments` bucket. Current FC `uploadAttachment` returns a public-object URL that 403s; `GET /v1/attachments/{path}` needs a bearer header (unusable as plain `AsyncImage` src). Preserve long expiry — URLs are persisted into message content / OutboxMessage and shared cross-client.
  2. Same routes cover `bucket=avatars` — reuse for Actors avatar gap.
- **Files:** `services/fc/lib/routes/attachments.mjs`, `supabase-repo.mjs`, `repository-contract.mjs`, `docs/openapi/teamclaw-api.v1.yaml`.

### Onboarding store / Auth — `riskLevel: low` mechanically, gated by release window
- **Already migrated:** `CloudAPIAppOnboardingStore` fully implements `AppOnboardingStore` over `/v1/auth/*` + `/v1/me/bootstrap` + `/v1/teams` + `/v1/invites/claim`; it is the production default.
- **iOS edits (7a):** `ContentView.swift:58` (drop Supabase fallback → `FailingOnboardingStore`); `CloudAPIConfiguration.swift` (stop requiring `supabaseURL/anonKey`; always have bundled `cloudApiUrl`); keep `SupabaseSessionBridge` legacy provider.
- **iOS edits (7b):** delete `SupabaseSessionBridge.swift`, `SupabaseAppOnboardingStore.swift`, all sibling `Supabase*Repository.swift`, `SupabasePushAdapters.swift`; `ContentView.swift:50` → `legacyRefreshTokenProvider: { nil }`.
- **Backend gaps:** none.
- **Gotchas:** `tokenRefreshes()` has no REST equiv — MQTT reconnect (`ContentView:132`) depends on `SessionStore` emitting on every refresh; regression-test a ~1h session. `createTeam` loses `workspaceID/Name` (hardcoded ""); confirm `OnboardingLocalCacheBootstrapper.prime` tolerates empty. Verify `/v1/invites/claim` surfaces a distinguishable "auth required" (42501-equivalent) error so `claimInviteSmart` anon fallback still triggers.

---

## 4. Shared Infrastructure

### Factory methods to add (`CloudAPI/CloudAPIRepositories.swift`, mirror existing `sessionsRepository`/`messagesRepository`/`agentRuntimesRepository`)
- `workspacesRepository(configuration:accessToken:)`
- `sessionRepository(configuration:accessToken:)`
- `actorRepository(configuration:accessToken:)`
- `agentAccessRepository(configuration:accessToken:)`
- `ideasRepository(configuration:accessToken:memberActorID:)`
- `shortcutsRepository(configuration:accessToken:)`
- `storageRepository(configuration:accessToken:)`
- `pushTokenUploader / pushPreferences / presenceWriter(configuration:accessToken:)`
- (`teamRepository` already exists.)
The `accessToken` closure `{ [store] in try await store.accessToken() }` is the canonical token plumbing root.

### `CloudAPIClient.swift` verb additions (Batch 0)
- `deleteVoid(path:)` — participants/mute removal.
- `putVoid` / `put` — prefs save.
- `getVoid` — optional.
- `postRaw(path:bytes:contentType:)` + `getRaw(path:) -> (Data, mime)` — Attachments only.

### Injection plumbing
- **`TeamRuntimeContext.swift`**: add slots `workspacesRepo` (exists), `sessionRepo`, `teamRepo`, `agentAccessRepo` (typed, verify wiring), `ideasRepo`. These are the canonical injection points — AMUXUI sheets and ViewModels currently bypass them by building Supabase repos inline.
- **`AppOnboardingCoordinator.swift` (~207-241)**: the single place that reads `CloudAPIConfigurationStore.configuration()` and builds every cloud repo via factory + `store.accessToken()`; add each new repo here with `?? (try? Supabase...())` fallback during migration, drop fallback in 7b.
- **`TeamclawService.swift:1336`**: stop constructing `SupabaseAgentAccessRepository` ad hoc — use injected `agentAccessRepo`.
- **`AMUXApp.swift` / `PushBootstrap.swift`**: replace raw `SupabaseClient` push wiring with CloudAPI adapters.

### Guardrail-test expansion (`Tests/AMUXCoreTests/Auth/NoSupabaseAuthImportTests.swift`)
- Currently scans only `CloudAPI/Auth/`. Final state: assert **zero `import Supabase`** across all of `AMUXCore/Sources`, `AMUXApp`, and `AMUXUI`. Expand the scan root incrementally per batch (add each migrated directory) so regressions are caught early; flip to full-tree assertion in 7b.

### `supabase-swift` dependency removal (final, 7b only)
- `Package.swift` declares `supabase-swift 2.43.1` feeding the Supabase product to AMUXCore. Remove the dependency + product reference **only after** ToolSearch/grep confirms zero `import Supabase` anywhere. Removing it earlier breaks compilation of any remaining Supabase file.

---

## 5. Risks, Unknowns, and Human Decisions Needed

### MISSING endpoints (hard blockers — must build in FC before the owning batch)
- **Attachments presign** (private bucket, tokenless 1-yr signed URL in persisted message content). *Decision:* presign endpoint vs authenticated-proxy + rewrite all `AsyncImage` call-sites. Presign strongly preferred (preserves cross-client URL-in-content model).
- **Device push-token registration** — no route; push breaks without it.
- **`share_agent_to_team` / `make_agent_personal`** — zero Cloud API surface.
- **Ideas `reorderIdeas` + `GET listIdeaActivities`** — no routes.
- **Member self-profile + avatar upload** (Actors) — no member-scoped profile route; no avatar storage route.

### Realtime / storage features with no REST equivalent
- **`tokenRefreshes()`** (auth state stream) — replaced by `SessionStore.emitRefresh()`; **MQTT reconnect silently dies at JWT expiry if this stream stops emitting.** Highest behavioral risk; requires a real ~1h-session regression test.
- **Attachment signed URLs** — the persisted-URL-in-message-content model is fundamentally tied to tokenless fetch; the bearer-gated download path is NOT a drop-in.
- No Supabase realtime *subscriptions* are in scope for any repo domain (live session subscribe is `TeamclawService.subscribeToSession`, untouched).

### Behavioral diffs to accept or escalate
- Session-create **per-participant roles dropped** (FC takes flat `participantActorIds[]`). Acceptable if roles are advisory; escalate if not.
- `createSession` **no `summary` persisted** (sent as first message) — confirmed harmless.
- `addParticipants` partial-failure semantics change (N→1 loop vs batch insert) — idempotent, acceptable.
- Team **`ownerDisplayName` → "—"** unless an owner field is added to FC.
- `teamAgentCount` loses exact count (listTeamActors caps at 500, RLS-scoped) — acceptable for first-agent reminder.
- `isSessionMuted` becomes a full-list fetch + membership test (N+1 → list).

### Decisions a human must make
1. **`removeActor` team-scoping:** widen iOS protocol to `removeActor(teamID:actorID:)` vs add unscoped `DELETE /v1/actors/{actorId}` in FC.
2. **`updateAgentDefaults` return:** make FC return updated row vs iOS reconstruct locally.
3. **Attachment URL strategy:** presign endpoint vs authenticated proxy (affects iOS call-sites).
4. **Migration window length:** how many releases the `SupabaseSessionBridge` runs before SDK removal (≥1 mandatory; the silent-signout risk is real for users whose session lives only in the SDK keychain).
5. **Roles-at-create:** preserve via new FC `participants[]{actorId,role}` shape, or drop.
6. **OpenAPI reconciliation scope:** fix all 6+ stale schemas now (contract correctness) vs lazily — runtime already works against live FC, so doc fixes are non-blocking but advised.

### Cross-cutting sequencing constraint
`SupabaseProjectConfiguration` / `SupabaseServerStore` / `SignUpOutcome` are shared by ~8 repos + push wiring and live in `SupabaseAppOnboardingStore.swift`. **Relocate them in Batch 0**, or the file (and SDK) cannot be deleted in 7b regardless of repo migration progress.