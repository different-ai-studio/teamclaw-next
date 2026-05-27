begin;

select plan(21);

-- ---------------------------------------------------------------------------
-- Test helpers (copied from tests/007 for self-containment)
-- ---------------------------------------------------------------------------
create or replace function pg_temp.as_user(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
                     true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create or replace function pg_temp.as_anon()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('role', 'anon')::text,
                     true);
  perform set_config('role', 'anon', true);
end;
$$;

create or replace function pg_temp.as_service_role()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('role', 'service_role')::text,
                     true);
  perform set_config('role', 'service_role', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixtures: alice (owner), bob (same team), cara (stranger)
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, aud, role, instance_id) values
  ('a1111111-1111-1111-1111-111111111111', 'alice-oss@amux.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('b2222222-2222-2222-2222-222222222222', 'bob-oss@amux.test',   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('c3333333-3333-3333-3333-333333333333', 'cara-oss@amux.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
on conflict do nothing;

select pg_temp.as_user('a1111111-1111-1111-1111-111111111111');
select * from public.create_team('OSS Team');

create temp table ctx as
  select (select id from public.teams where slug = 'oss-team') as team_id,
         'a1111111-1111-1111-1111-111111111111'::uuid           as alice,
         'b2222222-2222-2222-2222-222222222222'::uuid           as bob,
         'c3333333-3333-3333-3333-333333333333'::uuid           as cara;

-- Bob joins alice's team as a regular member. RLS on public.actors only lets
-- a user insert their own row, so seed Bob as the table owner with RLS off.
-- Use raw role/RLS toggle (not as_service_role) because temp tables created
-- by the postgres login can't be read after `set role service_role`.
set local role postgres;
set local row_security = off;

insert into public.actors (id, team_id, actor_type, display_name, user_id)
  values ('b2222222-0000-0000-0000-000000000000',
          (select id from public.teams where slug = 'oss-team'),
          'member', 'Bob',
          'b2222222-2222-2222-2222-222222222222');

insert into public.members (id, status)
  values ('b2222222-0000-0000-0000-000000000000', 'active');

insert into public.team_members (id, team_id, member_id, role)
  values ('b2222222-0000-0000-0000-000000000001',
          (select id from public.teams where slug = 'oss-team'),
          'b2222222-0000-0000-0000-000000000000',
          'member');

-- Return to the default test identity (alice) for the assertions below.
select pg_temp.as_user((select alice from ctx));

-- ---------------------------------------------------------------------------
-- §2.1: team_workspace_config gains sync_mode / oss_change_seq / litellm_team_id
-- ---------------------------------------------------------------------------
select has_column('public', 'team_workspace_config', 'sync_mode',
                  'team_workspace_config.sync_mode exists');
select col_default_is('public', 'team_workspace_config', 'sync_mode', 'git',
                  'sync_mode defaults to git');
select has_column('public', 'team_workspace_config', 'oss_change_seq',
                  'team_workspace_config.oss_change_seq exists');
select has_column('public', 'team_workspace_config', 'litellm_team_id',
                  'team_workspace_config.litellm_team_id exists');

-- Check constraint rejects unknown sync_mode values (run as postgres to bypass RLS).
set local role postgres;
set local row_security = off;
prepare bad_sync_mode as
  insert into public.team_workspace_config (team_id, sync_mode)
  values ((select team_id from ctx), 'lolwhat');
select throws_ok(
  'execute bad_sync_mode',
  '23514',  -- check_violation
  null,
  'sync_mode check constraint rejects unknown values');
deallocate bad_sync_mode;
select pg_temp.as_user((select alice from ctx));

-- ---------------------------------------------------------------------------
-- §2.2: amuxc_blobs
-- ---------------------------------------------------------------------------
select has_table('public', 'amuxc_blobs', 'amuxc_blobs table exists');
select col_is_pk('public', 'amuxc_blobs',
                 array['team_id', 'content_hash'],
                 'amuxc_blobs PK is (team_id, content_hash)');
select col_not_null('public', 'amuxc_blobs', 'oss_key',
                    'amuxc_blobs.oss_key is NOT NULL');
select col_default_is('public', 'amuxc_blobs', 'verified', 'false',
                      'amuxc_blobs.verified defaults to false');

-- Deleting the team cascades into amuxc_blobs.
set local role postgres;
set local row_security = off;
do $$
declare v_team uuid;
begin
  insert into public.teams (slug, name) values ('blob-cascade', 'Blob Cascade')
    returning id into v_team;
  insert into public.amuxc_blobs (team_id, content_hash, oss_key, size)
    values (v_team, 'deadbeef', 'teams/x/blobs/sha256/de/ad/beef', 42);
  delete from public.teams where id = v_team;
end $$;
select is_empty(
  'select 1 from public.amuxc_blobs where content_hash = ''deadbeef''',
  'amuxc_blobs cascades on team delete');
select pg_temp.as_user((select alice from ctx));

-- ---------------------------------------------------------------------------
-- §2.3: amuxc_files — unique on (team_id, path) full (not partial), to
-- preserve the soft-delete-then-revive invariant.
-- ---------------------------------------------------------------------------
select has_table('public', 'amuxc_files', 'amuxc_files table exists');
select col_default_is('public', 'amuxc_files', 'deleted', 'false',
                      'amuxc_files.deleted defaults to false');
select col_default_is('public', 'amuxc_files', 'current_version', '0',
                      'amuxc_files.current_version defaults to 0');

-- Unique (team_id, path) — not partial. Tombstone + revive must update the
-- existing row, never insert a second one.
select indexes_are('public', 'amuxc_files',
  array['amuxc_files_pkey', 'uniq_amuxc_path',
        'idx_amuxc_files_team_updated', 'idx_amuxc_files_team_seq'],
  'amuxc_files has expected indexes');

-- Same path can be inserted only once even when first row is deleted=true.
set local role postgres;
set local row_security = off;
create temp table _files_uniq_result (got_unique_violation boolean) on commit drop;
do $$
declare v_team uuid; v_actor uuid; v_file uuid; v_err text;
begin
  insert into public.teams (slug, name) values ('files-uniq', 'Files Uniq')
    returning id into v_team;
  insert into public.actors (team_id, actor_type, display_name, user_id)
    values (v_team, 'member', 'X', 'a1111111-1111-1111-1111-111111111111')
    returning id into v_actor;
  insert into public.amuxc_files (team_id, path, deleted, updated_by)
    values (v_team, 'skills/x.md', true, v_actor) returning id into v_file;
  begin
    insert into public.amuxc_files (team_id, path, deleted, updated_by)
      values (v_team, 'skills/x.md', false, v_actor);
    v_err := 'no-error';
  exception when unique_violation then
    v_err := 'unique_violation';
  end;
  insert into _files_uniq_result values (v_err = 'unique_violation');
  delete from public.teams where id = v_team;
end $$;
select ok((select got_unique_violation from _files_uniq_result),
          'amuxc_files rejects duplicate (team_id, path) even when soft-deleted');
select pg_temp.as_user((select alice from ctx));

-- ---------------------------------------------------------------------------
-- §2.4: amuxc_file_versions — immutable chain. (file_id, version) unique.
-- ---------------------------------------------------------------------------
select has_table('public', 'amuxc_file_versions',
                 'amuxc_file_versions table exists');
select col_is_unique('public', 'amuxc_file_versions',
                     array['file_id', 'version'],
                     'amuxc_file_versions has unique (file_id, version)');

-- Deleting an amuxc_files row cascades into its version chain.
set local role postgres;
set local row_security = off;
do $$
declare v_team uuid; v_actor uuid; v_file uuid;
begin
  insert into public.teams (slug, name) values ('ver-cascade', 'Ver Cascade')
    returning id into v_team;
  insert into public.actors (team_id, actor_type, display_name, user_id)
    values (v_team, 'member', 'X', 'a1111111-1111-1111-1111-111111111111')
    returning id into v_actor;
  insert into public.amuxc_files (team_id, path, updated_by)
    values (v_team, 'skills/v.md', v_actor) returning id into v_file;
  insert into public.amuxc_file_versions
    (file_id, version, parent_version, content_hash, size, created_by)
    values (v_file, 1, 0, 'abc', 10, v_actor);
  -- Delete amuxc_files first (cascades to amuxc_file_versions), then team.
  -- Direct team delete would hit restrict FK from amuxc_file_versions.created_by → actors.
  delete from public.amuxc_files where id = v_file;
  delete from public.teams where id = v_team;
end $$;
select is_empty(
  'select 1 from public.amuxc_file_versions where content_hash = ''abc''',
  'amuxc_file_versions cascades when parent amuxc_files row is deleted');
select pg_temp.as_user((select alice from ctx));

-- ---------------------------------------------------------------------------
-- §2.5: amuxc_upload_sessions
-- ---------------------------------------------------------------------------
select has_table('public', 'amuxc_upload_sessions',
                 'amuxc_upload_sessions table exists');
select col_default_is('public', 'amuxc_upload_sessions', 'status', 'pending',
                      'amuxc_upload_sessions.status defaults to pending');

-- Status check constraint rejects unknown values.
set local role postgres;
set local row_security = off;
prepare bad_status as
  insert into public.amuxc_upload_sessions
    (team_id, actor_id, path, parent_version, content_hash, size,
     oss_key, status, expires_at)
  values ((select team_id from ctx),
          (select id from public.actors where user_id = (select alice from ctx)
                                          and team_id = (select team_id from ctx)),
          'skills/x.md', 0, 'abc', 1,
          'teams/x/blobs/sha256/ab/c', 'lolwhat', now() + interval '1 hour');
select throws_ok(
  'execute bad_status',
  '23514',
  null,
  'amuxc_upload_sessions.status rejects unknown values');
deallocate bad_status;
select pg_temp.as_user((select alice from ctx));

select * from finish();
rollback;
