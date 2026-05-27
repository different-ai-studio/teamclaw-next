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

commit;
