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
