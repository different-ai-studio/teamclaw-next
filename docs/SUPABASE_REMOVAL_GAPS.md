# Supabase Removal — Live Gap Tracker

PR: `agent/remove-supabase-from-rust`. This doc tracks FC implementation gaps
that surfaced after removing the frontend's `supabase` delegate fallback.
Updated as issues are found in `.worktrees/preview-integration` live preview
and as fixes deploy.

## Status legend
- 🔴 broken in prod
- 🟡 fixing
- 🟢 deployed + smoke-tested
- ⚪ planned

## Confirmed gaps

| # | Endpoint / Symptom | Root cause | Fix | Status | Commit |
|---|---|---|---|---|---|
| 1 | `s.yaml` didn't pass `SUPABASE_ANON_KEY` to FC runtime | auth repo construction throws "PUBLISHABLE_KEY required" | add env var to s.yaml | 🟢 | `bc697904` |
| 2 | Node 20 `WebSocket` missing → supabase-js v2.45 throws at `createClient` | FC runtime is Node 20; supabase-js initializes RealtimeClient eagerly | install `ws`, pass `realtime: { transport: WebSocket }` | 🟢 | `a531b096` |
| 3 | `/v1/invites/claim` → 500 "internal" | raw supabase RPC error has no http_status; falls through `mapSupabaseError` to 500 | wrap claimInvite errors in proper `ApiError` (404/409) | 🟢 | `a531b096` |
| 4 | All new `GET /v1/...?queryParam=` returned 400 "X is required" | router's `queryParams` only checked `queryStringParameters` + `rawQueryString`; FC HTTP trigger sends `event.queryString` | extend `queryParams()` to handle all event shapes | 🟢 | `844661ec` |
| 5 | `/v1/teams/:teamId/actors` → 500 `listTeamActors is not a function` | route exists but supabase-repo lacks the method (pre-existing FC gap) | add `listTeamActors` to business repo (queries `actor_directory`) | 🟡 | pending deploy |
| 6 | `/v1/notifications/prefs` → 500 `column notification_prefs.push_enabled does not exist` | supabase-repo selected fictional columns; real schema is `enabled / dnd_start_min / dnd_end_min / dnd_tz` | rewrite get/put to real columns; return snake_case to match frontend type; return `null` when no row | 🟡 | pending deploy |
| 7 | `/v1/shortcuts?scope=personal` → 404 | frontend calls `/v1/shortcuts?scope=&teamId=` but FC only had `/v1/teams/:teamId/shortcuts` | add `GET /v1/shortcuts` route + `listShortcutsByScope` repo method; **also fixed pre-existing `listShortcuts` ordering by wrong column `"position"` (real column is `"order"`)** | 🟡 | pending deploy |
| 8 | `/v1/notifications/muted-sessions` → 404 | route never registered; frontend calls it via `listMutedSessionIds` | add `GET /v1/notifications/muted-sessions` route | 🟡 | pending deploy |
| 9 | `POST /v1/notifications/prefs` was 404 | frontend client uses POST but FC only had PUT | mirror POST handler alongside PUT | 🟡 | pending deploy |

## Suspected gaps (not yet hit in prod)

Other cloud-api modules that previously relied on the supabase delegate but whose
FC implementations may have signature mismatches. Will be checked by a follow-up
audit pass:
- `actors.getActor`, `actors.upsertExternalActor`, `actors.upsertAgentRuntime`
- `messages.*` (write paths)
- `sessions.create*`, `sessions.update*`
- `runtime.*`
- `attachments.*` upload signatures

## Untestable without live data (need user to exercise)

- Real `signin-otp` → email delivery
- Real `verify-otp` → session establishment
- Real `signOut` while authed
- `updateUser` (avatar / metadata update)
- daemon `amuxd init` end-to-end with real invite token

## How to update this doc

When a new failure appears in preview / prod:
1. Add row to "Confirmed gaps" with 🔴 + symptom + suspected root cause.
2. Move to 🟡 when fix in flight; record TBD commit.
3. Move to 🟢 when deployed + smoke-tested, fill in commit SHA.
