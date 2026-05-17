-- 2026-05-17: push notifications foundation
-- Five tables + RLS for: device tokens, global prefs, per-session mute,
-- foreground presence heartbeat, dispatch idempotency.

create table public.device_push_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  device_id    text not null,
  platform     text not null check (platform in ('ios','android','desktop')),
  provider     text not null check (provider in ('apns','jpush','tauri')),
  token        text not null,
  app_version  text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at   timestamptz,
  unique (user_id, device_id, provider)
);
create index if not exists device_push_tokens_user_active_idx
  on public.device_push_tokens (user_id) where revoked_at is null;

create table public.notification_prefs (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  enabled       boolean not null default true,
  dnd_start_min smallint check (dnd_start_min between 0 and 1439),
  dnd_end_min   smallint check (dnd_end_min between 0 and 1439),
  dnd_tz        text not null default 'Asia/Shanghai',
  updated_at    timestamptz not null default now()
);

create table public.session_mutes (
  user_id    uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  muted_at   timestamptz not null default now(),
  primary key (user_id, session_id)
);

create table public.client_presence (
  user_id          uuid not null references auth.users(id) on delete cascade,
  device_id        text not null,
  foreground_until timestamptz not null,
  primary key (user_id, device_id)
);

create table public.push_idempotency (
  message_id uuid primary key references public.messages(id) on delete cascade,
  claimed_at timestamptz not null default now()
);
create index if not exists push_idempotency_claimed_at_idx
  on public.push_idempotency(claimed_at);

-- RLS: every table is owner-only for authenticated reads/writes.
-- FC uses service-role key which bypasses RLS.

alter table public.device_push_tokens enable row level security;
create policy device_push_tokens_owner on public.device_push_tokens
  for all to authenticated
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.notification_prefs enable row level security;
create policy notification_prefs_owner on public.notification_prefs
  for all to authenticated
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.session_mutes enable row level security;
create policy session_mutes_owner on public.session_mutes
  for all to authenticated
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.client_presence enable row level security;
create policy client_presence_owner on public.client_presence
  for all to authenticated
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.push_idempotency enable row level security;
-- No authenticated policy: only service-role FC may touch this table.
