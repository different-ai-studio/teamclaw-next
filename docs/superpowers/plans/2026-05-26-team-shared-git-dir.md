# Team Shared Git Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the old Git-backed team-management surface with a team-scoped shared Git directory inside each workspace, for example `<workspace>/teamclaw`. The shared directory can be configured, validated, cloned, synced at startup, and used as the backing store for team-level environment variables.
**Architecture:** Supabase remains the source of truth for per-team workspace Git configuration. Desktop owns local setup, validation, manual sync, and team shared-secret editing. Daemon owns startup sync and injects decrypted team environment variables into ACP runtime processes. The workspace root stays unchanged; Git is scoped to a configurable child directory.
**Tech Stack:** Supabase Postgres/RLS/pgTAP, Tauri Rust commands, React/Vitest settings UI, daemon Rust runtime, Git CLI, AES-256-GCM shared-secret envelopes.

---

## File Structure

```text
services/supabase/migrations/202605260001_team_shared_git_dir.sql
services/supabase/tests/007_team_workspace_config.sql
packages/app/src/lib/team-workspace-config.ts
packages/app/src/lib/__tests__/team-workspace-config.test.ts
packages/app/src/components/settings/team/TeamGitConfig.tsx
packages/app/src/components/settings/team/__tests__/TeamGitConfig.test.tsx
apps/desktop/src/commands/mod.rs
apps/desktop/src/lib.rs
apps/desktop/src/commands/team.rs
apps/desktop/src/commands/team_shared_git.rs
apps/desktop/src/commands/shared_secrets.rs
apps/daemon/Cargo.toml
apps/daemon/src/backend/mod.rs
apps/daemon/src/backend/mock.rs
apps/daemon/src/supabase/client.rs
apps/daemon/src/runtime/adapter.rs
apps/daemon/src/runtime/manager.rs
apps/daemon/src/daemon/server.rs
apps/daemon/src/team_shared_git.rs
apps/daemon/src/team_shared_env.rs
```

## Data Model

- [ ] Add shared-directory fields to `team_workspace_config`.

Create `services/supabase/migrations/202605260001_team_shared_git_dir.sql`:

```sql
alter table public.team_workspace_config
  add column if not exists shared_dir_name text not null default 'teamclaw',
  add column if not exists env_secret text not null default encode(extensions.gen_random_bytes(32), 'hex'),
  add column if not exists last_sync_at timestamptz,
  add column if not exists last_sync_error text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'team_workspace_config_shared_dir_name_check'
      and conrelid = 'public.team_workspace_config'::regclass
  ) then
    alter table public.team_workspace_config
      add constraint team_workspace_config_shared_dir_name_check
      check (
        shared_dir_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
        and shared_dir_name not in ('.', '..')
      );
  end if;
end $$;
```

- [ ] Update `services/supabase/tests/007_team_workspace_config.sql`.

Extend the plan count, verify the new columns exist, verify the shared-dir constraint rejects `../bad`, and verify authenticated team members can still select the config while anon cannot. Do not weaken existing RLS.

- [ ] Update `packages/app/src/lib/team-workspace-config.ts`.

Extend `TeamWorkspaceConfig`:

```ts
export interface TeamWorkspaceConfig {
  teamId: string
  gitUrl: string | null
  gitBranch: string | null
  gitToken: string | null
  aiGatewayEndpoint: string | null
  sharedDirName: string
  envSecret: string | null
  lastSyncAt: string | null
  lastSyncError: string | null
  enabled: boolean
  updatedAt: string
}
```

Map Supabase snake_case fields to camelCase. `sharedDirName` must default to `teamclaw` in the TypeScript mapping for older local rows. `envSecret` should be read after create/update but never rendered as plain UI copy.

- [ ] Add `packages/app/src/lib/__tests__/team-workspace-config.test.ts`.

Cover row mapping, default `sharedDirName`, and upsert payload shape. If a test file already exists in this worktree, extend it instead of replacing it.

## Desktop Shared Git Commands

- [ ] Add `apps/desktop/src/commands/team_shared_git.rs`.

Implement focused commands for the new model:

```rust
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSharedGitConfig {
    pub workspace_path: String,
    pub git_url: String,
    pub git_branch: Option<String>,
    pub git_token: Option<String>,
    pub shared_dir_name: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSharedGitStatus {
    pub shared_dir_path: String,
    pub exists: bool,
    pub is_git_repo: bool,
    pub remote_url: Option<String>,
    pub branch: Option<String>,
    pub dirty: bool,
    pub ahead: i32,
    pub behind: i32,
}
```

Required commands:

```rust
#[tauri::command]
pub async fn team_shared_git_validate(config: TeamSharedGitConfig) -> Result<TeamSharedGitStatus, String>;

#[tauri::command]
pub async fn team_shared_git_setup(config: TeamSharedGitConfig) -> Result<TeamSharedGitStatus, String>;

#[tauri::command]
pub async fn team_shared_git_sync(config: TeamSharedGitConfig, force: Option<bool>) -> Result<TeamSyncResult, String>;
```

Behavior:

- `shared_dir_name` defaults to `teamclaw`.
- Reject absolute names, path separators, `.`, `..`, and names longer than 64 chars.
- Resolve the target as `<workspace_path>/<shared_dir_name>` and verify it stays under `workspace_path`.
- `setup` clones when absent, validates remote when present, and creates `_secrets/` inside the shared directory.
- `sync` preserves the current `team_sync_repo` behavior: stage local changes, auto-commit with a deterministic message, fetch, pull with rebase, push, return conflict/confirmation states.
- Reuse the old token embedding logic, but never log the tokenized URL.
- Do not read or write `_meta/team.json`, `_meta/members.json`, or the old team HMAC secret.

- [ ] Register the new module and commands.

Update `apps/desktop/src/commands/mod.rs`:

```rust
pub mod team_shared_git;
```

Update `apps/desktop/src/lib.rs` `generate_handler!` list:

```rust
commands::team_shared_git::team_shared_git_validate,
commands::team_shared_git::team_shared_git_setup,
commands::team_shared_git::team_shared_git_sync,
```

- [ ] Keep `team_sync_repo` as a compatibility wrapper.

In `apps/desktop/src/commands/team.rs`, retarget the exported `team_sync_repo` to load local team config and call the new shared-directory sync. This preserves existing frontend startup callers while moving the implementation away from `TEAM_REPO_DIR`.

- [ ] Add Rust unit tests in `apps/desktop/src/commands/team_shared_git.rs`.

Cover shared-dir-name validation, path containment, token redaction, status parsing, and sync no-op when there are no local changes.

## Desktop Team Secrets

- [ ] Extend local team config in `apps/desktop/src/commands/team.rs`.

The `.teamclaw/teamclaw.json` team section must carry:

```json
{
  "teamId": "...",
  "sharedDirName": "teamclaw",
  "envSecret": "<64 hex chars>"
}
```

Keep reading older configs, default `sharedDirName` to `teamclaw`, and return a clear error if team shared secrets are requested without `envSecret`.

- [ ] Retarget `apps/desktop/src/commands/shared_secrets.rs`.

Change lazy initialization from:

```text
<workspace>/teamclaw-team/_secrets
```

to:

```text
<workspace>/<sharedDirName>/_secrets
```

Derive the encryption key from `envSecret` using the existing `shared_secrets_crypto::derive_key_from_secret` path. Remove the dependency on `team_secret_store` for the active flow. Existing commands `shared_secret_set`, `shared_secret_delete`, and `shared_secret_list` remain unchanged at the Tauri API boundary.

- [ ] Reload shared secrets after shared Git sync.

`team_shared_git_sync` should call the existing reload hook after pull/rebase so changed `_secrets/*.enc.json` files are reflected without app restart.

## Frontend Settings Flow

- [ ] Update `packages/app/src/components/settings/team/TeamGitConfig.tsx`.

Keep this component name for a smaller diff, but change the user-facing model to "团队共享目录":

- Git repository URL, branch, token, and shared directory name.
- Default shared directory name: `teamclaw`.
- Validate/setup/sync actions call the new Tauri commands.
- Do not render old Git team invite/member repository controls.
- After creating or updating the Supabase config, read back `envSecret` and persist `teamId`, `sharedDirName`, and `envSecret` to `.teamclaw/teamclaw.json` via `save_team_config`.

Suggested command wrapper shape:

```ts
await invoke('team_shared_git_setup', {
  config: {
    workspacePath,
    gitUrl: form.gitUrl,
    gitBranch: form.gitBranch || null,
    gitToken: form.gitToken || null,
    sharedDirName: form.sharedDirName || 'teamclaw',
  },
})
```

- [ ] Remove active calls to `init_git_team_secrets`.

Team-level env vars now use `envSecret` from `team_workspace_config`, not the old team secret. Leave the old command registered only as a compatibility escape hatch until no stored configs rely on it.

- [ ] Add/update frontend tests.

In `packages/app/src/components/settings/team/__tests__/TeamGitConfig.test.tsx`, verify:

- default directory name is `teamclaw`;
- setup invokes `team_shared_git_setup`;
- sync invokes `team_shared_git_sync`;
- saved local team config includes `sharedDirName` and does not call `init_git_team_secrets`.

## Daemon Shared Git Sync

- [ ] Add daemon config read support.

In `apps/daemon/src/supabase/client.rs`, add a row type:

```rust
#[derive(Debug, Clone, serde::Deserialize)]
pub struct TeamWorkspaceConfigRow {
    pub team_id: String,
    pub git_url: Option<String>,
    pub git_branch: Option<String>,
    pub git_token: Option<String>,
    pub shared_dir_name: String,
    pub env_secret: String,
    pub enabled: bool,
}
```

Add a method that fetches the enabled config by the daemon's configured `team_id`:

```rust
async fn get_team_workspace_config(&self, team_id: &str) -> Result<Option<TeamWorkspaceConfigRow>>;
```

For the Supabase REST client, query:

```text
/rest/v1/team_workspace_config?team_id=eq.{team_id}&enabled=eq.true&select=team_id,git_url,git_branch,git_token,shared_dir_name,env_secret,enabled
```

Thread the method through `apps/daemon/src/backend/mod.rs` and `apps/daemon/src/backend/mock.rs`.

- [ ] Add `apps/daemon/src/team_shared_git.rs`.

Implement the same shared-dir validation and sync semantics as desktop, scoped to daemon startup:

```rust
pub async fn setup_or_sync_shared_dir(
    workspace_root: &Path,
    config: &TeamWorkspaceConfigRow,
) -> anyhow::Result<TeamSharedGitStatus>;
```

Rules:

- If `git_url` is empty, skip sync and return a non-error "not configured" status.
- If the directory does not exist and `git_url` exists, clone into `<workspace>/<shared_dir_name>`.
- If the directory exists, sync it.
- Auto-commit/push local daemon changes before pulling.
- Store `last_sync_at` or `last_sync_error` back to Supabase when possible.

- [ ] Call startup sync from `apps/daemon/src/daemon/server.rs`.

After the daemon resolves/registers a workspace root, fetch the enabled team workspace config and run `setup_or_sync_shared_dir`. Log failures with workspace id and shared directory name, but do not prevent the daemon from starting ACP runtimes unless the runtime explicitly needs team env vars.

## Daemon Team Environment Variables

- [ ] Add crypto-compatible loading in `apps/daemon/src/team_shared_env.rs`.

Read encrypted envelopes from:

```text
<workspace>/<sharedDirName>/_secrets/*.enc.json
```

Decrypt with `env_secret` using the same AES-256-GCM envelope format as `apps/desktop/src/commands/shared_secrets_crypto.rs`.

Add dependencies to `apps/daemon/Cargo.toml`:

```toml
aes-gcm = "0.10"
hkdf = "0.12"
sha2 = "0.10"
hex = "0.4"
```

`base64` already exists in daemon dependencies.

- [ ] Inject team env into ACP runtime processes.

Thread an `extra_env: HashMap<String, String>` from `apps/daemon/src/daemon/server.rs` through `RuntimeManager::spawn_agent_with_model` into `adapter::spawn_acp_agent` / `run_acp_session`, then call:

```rust
for (key, value) in extra_env {
    cmd.env(key, value);
}
```

Normalization rule:

- Preserve the stored key as-is.
- If the key is lowercase and an uppercase version is not already present, also inject uppercase.
- Never override explicit process/system env vars already set by the daemon command builder.

- [ ] Add daemon tests.

Cover envelope decryption, missing `_secrets` directory, invalid `env_secret`, lowercase/uppercase normalization, and ACP command env injection with a mock command builder or isolated adapter helper.

## Compatibility And Cleanup

- [ ] Leave old member-management structures out of the active flow.

Do not create, validate, or mutate:

```text
<sharedDir>/_meta/team.json
<sharedDir>/_meta/members.json
```

Do not expose the old Git invite/member management UI for this settings path.

- [ ] Keep old commands only where existing callers still require them.

Allowed temporary compatibility exports:

- `team_git_join`
- `team_git_join_background`
- `init_git_team_secrets`
- `get_git_team_secret`

These should not be called by the new UI. Add comments marking them legacy when touching nearby code.

## Verification

- [ ] Run targeted frontend tests:

```bash
pnpm --filter @teamclaw/app test:unit -- src/lib/__tests__/team-workspace-config.test.ts src/components/settings/team/__tests__/TeamGitConfig.test.tsx
```

- [ ] Run frontend typecheck:

```bash
pnpm typecheck
```

- [ ] Run desktop Rust tests:

```bash
cargo test -p teamclaw team_shared_git shared_secrets
```

- [ ] Run daemon Rust tests:

```bash
pnpm daemon:test -- team_shared
```

- [ ] Run Supabase pgTAP tests for the changed file, using the repo's existing Supabase test runner:

```bash
cd services/supabase
supabase test db
```

If the local Supabase CLI is unavailable, record that explicitly and run the TypeScript and Rust suites instead.

- [ ] Manual smoke test:

1. Configure a team Git URL with shared directory `teamclaw`.
2. Click setup and confirm `<workspace>/teamclaw/.git` exists.
3. Add a team env var with "Share with team".
4. Confirm the encrypted file appears under `<workspace>/teamclaw/_secrets`.
5. Restart daemon/app and confirm startup sync runs without using `<workspace>/teamclaw-team`.
6. Start an ACP runtime and confirm the team env var is present in the child process.
