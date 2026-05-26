begin;

select plan(18);

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

-- Fixture: owner (alice), stranger (bob)
insert into auth.users (id, email, aud, role, instance_id) values
  ('a1111111-1111-1111-1111-111111111111', 'alice-wc@amux.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('b2222222-2222-2222-2222-222222222222', 'bob-wc@amux.test',   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
on conflict do nothing;

select pg_temp.as_user('a1111111-1111-1111-1111-111111111111');
select * from public.create_team('WC Team');

create temp table ctx as
  select (select id from public.teams where slug = 'wc-team') as team_id;

-- 1. Table exists
select has_table('public', 'team_workspace_config', 'team_workspace_config table exists');

-- 2-9. Has expected columns
select has_column('public', 'team_workspace_config', 'team_id', 'has team_id');
select has_column('public', 'team_workspace_config', 'git_url', 'has git_url');
select has_column('public', 'team_workspace_config', 'git_token', 'has git_token');
select has_column('public', 'team_workspace_config', 'ai_gateway_endpoint', 'has ai_gateway_endpoint');
select has_column('public', 'team_workspace_config', 'shared_dir_name', 'has shared_dir_name');
select has_column('public', 'team_workspace_config', 'env_secret', 'has env_secret');
select has_column('public', 'team_workspace_config', 'last_sync_at', 'has last_sync_at');
select has_column('public', 'team_workspace_config', 'last_sync_error', 'has last_sync_error');

-- 10. Member can insert
insert into public.team_workspace_config (team_id, git_url, git_branch, git_token, ai_gateway_endpoint)
  values ((select team_id from ctx), 'https://github.com/x/y.git', 'main', 'ghp_abc', 'https://gw.example');
select pass('owner can insert own team_workspace_config');

-- 11. Member can read
select results_eq(
  $$ select git_url from public.team_workspace_config where team_id = (select team_id from ctx) $$,
  $$ values ('https://github.com/x/y.git'::text) $$,
  'owner reads own row'
);

-- 12. Anon cannot read
select pg_temp.as_anon();
select throws_ok(
  $$ select 1 from public.team_workspace_config where team_id = (select team_id from ctx) $$,
  '42501',
  null,
  'anon cannot read'
);

-- 13. Shared directory name rejects path traversal
select pg_temp.as_user('a1111111-1111-1111-1111-111111111111');
select throws_ok(
  $$ update public.team_workspace_config set shared_dir_name = '../bad' where team_id = (select team_id from ctx) $$,
  '23514',
  null,
  'shared_dir_name rejects path traversal'
);

-- 14. Stranger cannot read
select pg_temp.as_user('b2222222-2222-2222-2222-222222222222');
select is_empty(
  $$ select 1 from public.team_workspace_config where team_id = (select team_id from ctx) $$,
  'stranger cannot read'
);

-- 15. Stranger cannot insert
select throws_ok(
  $$ insert into public.team_workspace_config (team_id, git_url) values
       ((select team_id from ctx), 'https://github.com/h/h.git') $$,
  '42501',
  null,
  'stranger insert rejected'
);

-- 16. enabled defaults true (after switching back to alice)
select pg_temp.as_user('a1111111-1111-1111-1111-111111111111');
select results_eq(
  $$ select enabled from public.team_workspace_config where team_id = (select team_id from ctx) $$,
  $$ values (true) $$,
  'enabled defaults true'
);

-- 17. Stranger cannot delete (no rows affected, row still exists)
select pg_temp.as_user('b2222222-2222-2222-2222-222222222222');
delete from public.team_workspace_config where team_id = (select team_id from ctx);
select pg_temp.as_user('a1111111-1111-1111-1111-111111111111');
select isnt_empty(
  $$ select 1 from public.team_workspace_config where team_id = (select team_id from ctx) $$,
  'stranger cannot delete'
);

-- 18. Owner can delete their own row
delete from public.team_workspace_config where team_id = (select team_id from ctx);
select is_empty(
  $$ select 1 from public.team_workspace_config where team_id = (select team_id from ctx) $$,
  'owner can delete own row'
);

select * from finish();
rollback;
