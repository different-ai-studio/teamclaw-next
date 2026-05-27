-- 20260527000001_oss_sync_schema.sql
--
-- OSS Sync v3 (PR1): add sync_mode + waterline columns to
-- team_workspace_config, plus four new tables for content-addressed blob
-- tracking, file pointers, immutable version chain, and prepare/complete
-- upload sessions. Locks down sync-state fields via a BEFORE UPDATE trigger
-- so authenticated callers cannot rewrite the waterline.
--
-- See docs/superpowers/specs/2026-05-27-oss-sync-redesign-design.md §2.

begin;

-- ===========================================================================
-- 1. Extend team_workspace_config
-- ===========================================================================
alter table public.team_workspace_config
  add column if not exists sync_mode text not null default 'git'
    check (sync_mode in ('git', 'oss')),
  add column if not exists oss_change_seq bigint not null default 0,
  add column if not exists litellm_team_id text;

comment on column public.team_workspace_config.sync_mode is
  'Sync backend for this team. Set at team creation; immutable thereafter (enforced by trg_team_workspace_config_guard).';
comment on column public.team_workspace_config.oss_change_seq is
  'Per-team monotonic sequence written by /sync/upload/complete inside the same tx as amuxc_files.change_seq. Manifest high-water mark.';
comment on column public.team_workspace_config.litellm_team_id is
  'LiteLLM team id provisioned for this team during /sync/create-team.';

-- ===========================================================================
-- 2. amuxc_blobs: content-addressed blob registry, per-team isolated
-- ===========================================================================
create table public.amuxc_blobs (
  team_id      uuid        not null references public.teams(id) on delete cascade,
  content_hash text        not null,
  oss_key      text        not null,
  size         bigint      not null check (size >= 0),
  verified     boolean     not null default false,
  created_at   timestamptz not null default now(),
  primary key (team_id, content_hash)
);

create index idx_amuxc_blobs_verified_created
  on public.amuxc_blobs (created_at) where verified = false;

comment on table public.amuxc_blobs is
  'OSS blob registry. (team_id, content_hash) PK acts as a per-team dedup key. verified=false means prepare-stage placeholder, flipped true by /sync/upload/complete.';

-- ===========================================================================
-- 3. amuxc_files: current pointer per path
-- ===========================================================================
create table public.amuxc_files (
  id              uuid        primary key default gen_random_uuid(),
  team_id         uuid        not null references public.teams(id) on delete cascade,
  path            text        not null,
  current_version int         not null default 0,
  content_hash    text,                            -- cipher_hash; null only when deleted
  size            bigint      not null default 0 check (size >= 0),
  deleted         boolean     not null default false,
  change_seq      bigint      not null default 0,
  row_version     int         not null default 0,
  updated_by      uuid        not null references public.actors(id) on delete restrict,
  updated_at      timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create unique index uniq_amuxc_path
  on public.amuxc_files (team_id, path);
create index idx_amuxc_files_team_updated
  on public.amuxc_files (team_id, updated_at);
create index idx_amuxc_files_team_seq
  on public.amuxc_files (team_id, change_seq);

comment on table public.amuxc_files is
  'Current pointer per (team, path). Soft-delete keeps the same row (deleted=true) so revival increments current_version on the existing row and preserves the immutable version chain in amuxc_file_versions.';
comment on column public.amuxc_files.content_hash is
  'Ciphertext sha256 (see design §3.-1). Null iff deleted=true.';
comment on column public.amuxc_files.change_seq is
  'Per-team manifest sequence, assigned by /sync/upload/complete. See team_workspace_config.oss_change_seq.';

-- ===========================================================================
-- 4. amuxc_file_versions: append-only history
-- ===========================================================================
create table public.amuxc_file_versions (
  id                 uuid        primary key default gen_random_uuid(),
  file_id            uuid        not null references public.amuxc_files(id) on delete cascade,
  version            int         not null,
  parent_version     int         not null,
  content_hash       text,                       -- cipher_hash; null iff deleted version
  size               bigint      not null default 0 check (size >= 0),
  deleted            boolean     not null default false,
  created_by         uuid        not null references public.actors(id) on delete restrict,
  created_by_node_id text,
  message            text,
  created_at         timestamptz not null default now(),
  unique (file_id, version)
);

create index idx_amuxc_file_versions_file
  on public.amuxc_file_versions (file_id, version desc);

comment on table public.amuxc_file_versions is
  'Append-only version chain. parent_version=current_version at time of complete, so cas conflicts surface as a 409 before this row is written.';

-- ===========================================================================
-- 5. amuxc_upload_sessions: prepare/complete bridge
-- ===========================================================================
create table public.amuxc_upload_sessions (
  id              uuid        primary key default gen_random_uuid(),
  team_id         uuid        not null references public.teams(id) on delete cascade,
  actor_id        uuid        not null references public.actors(id) on delete cascade,
  node_id         text,
  path            text        not null,
  parent_version  int         not null,
  content_hash    text        not null,
  size            bigint      not null check (size >= 0),
  oss_key         text        not null,
  status          text        not null default 'pending'
    check (status in ('pending', 'completed', 'abandoned')),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null
);

create index idx_amuxc_sessions_expires
  on public.amuxc_upload_sessions (expires_at);
create index idx_amuxc_sessions_team_status
  on public.amuxc_upload_sessions (team_id, status);

comment on table public.amuxc_upload_sessions is
  'Tracks in-flight uploads between /prepare and /complete. actor_id is the creator; /complete must verify caller.actor_id == session.actor_id.';

commit;
