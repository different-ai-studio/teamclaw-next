-- Owner-initiated rollback of team-share: clear locked share_mode so the team
-- can choose oss / managed_git / custom_git again. Complements the once-only
-- enable path (public.enable_team_share).

begin;

-- Allow intentional share_mode reset when the disable RPC sets this GUC.
create or replace function app.guard_team_share_mode()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if old.share_mode is not null
     and new.share_mode is distinct from old.share_mode then
    if current_setting('app.allow_share_mode_reset', true) = 'on' then
      return new;
    end if;
    raise exception 'teams.share_mode is locked once enabled (was %, attempted %)',
      old.share_mode, new.share_mode
      using errcode = '23514';
  end if;
  return new;
end
$$;

create or replace function public.disable_team_share(p_team_id uuid)
returns public.teams
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_team public.teams;
begin
  perform set_config('app.allow_share_mode_reset', 'on', true);

  update public.teams
     set share_mode         = null,
         share_enabled_at   = null,
         git_remote_url     = null,
         git_auth_kind      = null,
         git_credential_ref = null
   where id = p_team_id
     and share_mode is not null
  returning * into v_team;

  if v_team.id is null then
    -- Idempotent: team missing or share already cleared.
    select * into v_team from public.teams where id = p_team_id;
    if v_team.id is null then
      raise exception 'team % does not exist', p_team_id
        using errcode = '23503';
    end if;
    perform set_config('app.allow_share_mode_reset', 'off', true);
    return v_team;
  end if;

  perform set_config('app.allow_sync_mode_switch', 'on', true);

  update public.team_workspace_config
     set sync_mode = null
   where team_id = p_team_id;

  perform set_config('app.allow_sync_mode_switch', 'off', true);
  perform set_config('app.allow_share_mode_reset', 'off', true);

  return v_team;
end
$$;

revoke all on function public.disable_team_share(uuid) from public;
grant execute on function public.disable_team_share(uuid) to service_role;

commit;
