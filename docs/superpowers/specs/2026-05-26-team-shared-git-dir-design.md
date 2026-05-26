# Team Shared Git Directory Design

Date: 2026-05-26

## Context

The current desktop team Git code still carries the older "Git team mode" shape: a cloned `teamclaw-team` repository contains `_meta/team.json`, `_meta/members.json`, encrypted `_secrets`, shared MCP files, and member join verification. Newer Supabase team creation no longer uses that full path, but several pieces remain:

- `team_workspace_config` stores a team-level Git URL, branch, token, and enabled flag.
- `team_sync_repo` can auto-commit local changes, pull/rebase, and push a local team Git repository.
- shared secrets are encrypted under `<team_dir>/_secrets` and resolved before local personal env vars.
- daemon workspaces are already represented by Supabase `workspaces` rows and local daemon `workspaces.toml`.

The new product direction is narrower: Git is only the backing store for a team-specific shared directory inside a daemon workspace, for example `<workspace>/teamclaw`. Git should not manage team membership, invite verification, or old team metadata. Automatic Git sync and local auto-commit/push should remain.

## Goals

- Configure a team-level shared directory name, defaulting to `teamclaw`.
- Clone the configured Git repository into each daemon workspace at `<workspace>/<shared_dir_name>`.
- Keep automatic startup sync and local auto-commit/push for that shared directory.
- Support team-level environment variables through encrypted files in the shared directory.
- Inject team-level environment variables into daemon-spawned agent processes.
- Remove the need for old Git team membership artifacts such as `_meta/team.json`, `_meta/members.json`, and team secret HMAC verification.

## Non-Goals

- Do not reintroduce Git-backed team membership management.
- Do not require members to join by committing themselves to a Git manifest.
- Do not use the shared Git repository as the workspace root; it is a subdirectory of the daemon workspace.
- Do not automatically sync the entire daemon workspace.
- Do not implement a new realtime secret transport; Git remains the transport for shared directory files.

## Proposed Model

Each team has one shared-directory configuration. Each daemon workspace has a local workspace root. The effective shared directory is derived at runtime:

```text
workspace.path      = /Users/me/project
shared_dir_name     = teamclaw
shared_dir_path     = /Users/me/project/teamclaw
```

The shared directory is the only path touched by the Git sync logic. The daemon runtime continues to run from the selected workspace path unless a flow explicitly targets the shared directory.

## Data Model

Extend `public.team_workspace_config` instead of overloading `workspaces.path`.

Suggested columns:

- `shared_dir_name text not null default 'teamclaw'`
- `git_url text`
- `git_branch text`
- `git_token text`
- `enabled boolean not null default true`
- `env_secret text`
- `last_sync_at timestamptz`
- `last_sync_error text`

`env_secret` is the team-shared key material used to derive the AES-GCM key for `_secrets`. It replaces the old local team secret dependency for this feature. It should be readable only by team members through existing RLS, matching the current `team_workspace_config` visibility. A later hardening pass can move it to an encrypted vault or credential reference.

`public.workspaces` remains the daemon workspace registry. Its `path` stays the workspace root, not the cloned Git directory.

## Git Setup And Validation

Add explicit setup commands for the shared directory:

- `team_shared_git_validate(workspace_id | workspace_path, config)`
- `team_shared_git_setup(workspace_id | workspace_path, force?)`
- `team_shared_git_sync(workspace_id | workspace_path, force?)`

Validation checks:

- Git CLI is installed.
- `git_url` is present when enabled.
- configured branch exists or remote default branch can be resolved.
- target path is exactly `<workspace>/<shared_dir_name>`.
- target path is absent, empty, or already the same Git remote.
- non-empty non-Git target directories are rejected.

Setup behavior:

- clone the repository into `<workspace>/<shared_dir_name>`.
- initialize `_secrets/` if missing.
- write local workspace metadata if needed so daemon can resolve the Supabase workspace id to the root workspace path.
- leave old `_meta/team.json` and `_meta/members.json` unused.

## Automatic Sync

Keep the useful behavior of `team_sync_repo`, but retarget it to the shared directory:

- On app/daemon startup, if team shared Git is enabled and the directory exists, run sync for `<workspace>/<shared_dir_name>`.
- If local changes exist, stage and auto-commit them.
- Fetch/pull/rebase against the configured branch.
- Push local commits after a successful rebase.
- Reload shared secrets from `_secrets/` after sync.
- Emit a status event so the UI can show last sync or errors.

The sync command must not create, modify, or reset files outside the shared directory. Conflict handling should stay conservative: abort rebase, preserve a local backup under the shared directory's `.trash/`, then either reset to remote or report the conflict according to the existing behavior chosen for `team_sync_repo`.

## Team Environment Variables

The existing env-var UI and shared secret shape can be retained, but initialization must change.

Current behavior:

- UI merges personal env vars and team shared secrets.
- `shared_secret_set` writes encrypted envelopes to `<team_dir>/_secrets`.
- `env_var_resolve` resolves shared secrets before personal local secrets.

Required change:

- `shared_secret_set`, `shared_secret_delete`, and `shared_secret_list` should initialize from the active team shared directory config, not from old `team.teamId` plus local team secret.
- The secrets directory becomes `<workspace>/<shared_dir_name>/_secrets`.
- Encryption key derivation uses `team_workspace_config.env_secret`.
- Sync reloads `_secrets` so newly pulled team env vars become available.

Shared env vars remain non-revealable after saving. Personal env vars remain stored in the local encrypted personal secret store.

## Daemon Runtime Injection

Daemon-spawned ACP processes currently start without loading TeamClaw shared secrets. Add an env loading step before `spawn_acp_agent`:

- resolve the selected workspace root.
- derive `<workspace>/<shared_dir_name>`.
- load and decrypt `_secrets/*.enc.json` using `env_secret`.
- merge them into the child process environment.
- inject both lowercase key ids and uppercase aliases, matching desktop OpenCode sidecar behavior.

Precedence for daemon agent environment:

1. team shared env vars
2. daemon process environment
3. launch-config explicit env, if such a field is added later

If secret loading fails, the runtime should fail fast with a clear configuration error when the workspace requires team shared envs. If the team shared directory is disabled or absent, daemon spawning keeps the current behavior.

## UI Changes

Replace the old Git team wording with "Team Shared Directory" semantics.

Settings should show:

- shared directory name, default `teamclaw`
- Git URL
- branch
- token/SSH guidance
- validation status
- setup button for the current daemon workspace
- last sync timestamp and last error
- manual sync button

Remove or hide old Git team fields and panels:

- team secret display
- member manifest details
- "join Git team" copy
- `_meta/team.json` validation copy

The environment variables page can keep its existing combined personal/team list, but the "Share with team" path should depend on the current Supabase team and shared directory config rather than the old Git team mode.

## Migration

For existing users with `<workspace>/teamclaw-team`:

- do not delete it automatically.
- if `team_workspace_config.git_url` exists and no `shared_dir_name` exists, default `shared_dir_name` to `teamclaw`.
- first-pass migration does not move old repositories automatically; users configure and run setup for `<workspace>/teamclaw` explicitly.
- shared secrets can be migrated by copying `_secrets` from the old team repo to the new shared directory only when the same encryption key can decrypt them. Otherwise keep old data untouched and ask the user to recreate team env vars.

## Testing

Database:

- migration test for new `team_workspace_config` columns and RLS.
- RLS test that non-members cannot read `env_secret`.

Desktop/Rust:

- path derivation rejects traversal and absolute shared directory names.
- validation handles missing Git, missing remote branch, non-empty target, and existing same remote.
- sync operates only inside the shared directory.
- shared secret init reads `env_secret` and writes to `<workspace>/<shared_dir_name>/_secrets`.

Daemon:

- workspace store still maps Supabase workspace ids to root paths.
- runtime spawn injects decrypted shared env vars.
- spawn behavior is unchanged when shared directory config is disabled.

Frontend:

- team shared directory form persists config.
- setup/sync buttons call the new commands with the current workspace.
- env-vars page still distinguishes personal and team entries.

## Risks

- Plaintext `git_token` and `env_secret` in `team_workspace_config` are acceptable for the first pass only because RLS already limits team-member access. A follow-up should move them to a vault or credential reference.
- Auto-commit/push can surprise users if the shared directory contains large or sensitive files. Keep the existing untracked-file precheck thresholds and show the confirmation dialog.
- If multiple daemons auto-sync concurrently, normal Git conflicts can occur. The first version should report conflicts clearly and avoid inventing a custom merge strategy.

## Acceptance Criteria

- A team admin can configure a Git repo and shared directory name.
- A daemon workspace can clone the repo into `<workspace>/teamclaw`.
- Startup sync preserves auto-commit/push behavior for that shared directory.
- Team env vars can be saved, synced through Git, loaded after sync, and injected into daemon ACP processes.
- No old Git membership manifest or team secret verification is required for the new flow.
