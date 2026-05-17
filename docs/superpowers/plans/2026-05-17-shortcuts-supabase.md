# Shortcuts → Supabase + Generic RBAC — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move personal + team shortcuts from local files / OSS / P2P file sync to Supabase, replacing the inline `ShortcutNode.role[]` ACL with a reusable RBAC layer (`team_roles`, `team_member_roles`, `permissions`, `permission_roles`) that shortcuts is the first consumer of.

**Architecture:** Single Postgres table `shortcuts` (scope-discriminated personal/team rows, tree via `parent_id`). RBAC = 4 tables. RLS handles visibility/edit auth; 4 RPCs handle multi-table atomicity (create, batch reorder, swap-in role sets). Front-end `useShortcutsStore` becomes async over supabase-js with a local Tauri-file cache for offline reads. **No data migration**: post-deploy, existing shortcut entries do not appear; users re-add.

**Tech Stack:** Postgres + pgTAP, Supabase RLS / RPC, supabase-js, Zustand, React 19, Tauri 2 (existing `save_shortcuts`/`load_shortcuts` Rust commands reused as opaque JSON cache), Vitest.

**Source spec:** `docs/superpowers/specs/2026-05-17-shortcuts-supabase-design.md`

---

## File Map

**New files:**

| Path | Purpose |
|---|---|
| `services/supabase/migrations/20260517100001_rbac_tables.sql` | `team_roles`, `team_member_roles`, `permissions`, `permission_roles` schema |
| `services/supabase/migrations/20260517100002_shortcuts_table.sql` | `shortcuts` table + indexes |
| `services/supabase/migrations/20260517100003_rbac_shortcuts_helpers.sql` | `app.is_team_admin_or_owner`, `app.member_can_access_permission`, `app.member_can_see_shortcut` |
| `services/supabase/migrations/20260517100004_rbac_shortcuts_rls.sql` | RLS policies for all 5 new tables |
| `services/supabase/migrations/20260517100005_rbac_shortcuts_rpcs.sql` | `shortcut_create`, `shortcut_batch_move`, `shortcut_set_visible_roles`, `team_member_set_roles`, cleanup trigger |
| `services/supabase/tests/015_rbac_shortcuts.sql` | pgTAP: schema, helpers, RLS, RPCs |
| `packages/app/src/lib/shortcuts-rpc.ts` | Typed wrappers around supabase-js for shortcut/RBAC operations + error normalization |
| `packages/app/src/lib/__tests__/shortcuts-rpc.test.ts` | Vitest for the wrappers |

**Modified files:**

| Path | Change |
|---|---|
| `packages/app/src/stores/shortcuts.ts` | Rewrite as async Supabase-backed store; remove `currentShortcutRoles`, `filterTeamTreeForRoles`; cache via existing `save_shortcuts`/`load_shortcuts` |
| `packages/app/src/stores/__tests__/shortcuts.test.ts` | Rewrite end-to-end against mocked supabase-js |
| `packages/app/src/stores/team-members.ts` | Drop `setCurrentShortcutRoles` glue |
| `packages/app/src/hooks/useAppInit.ts` | Replace `loadTeamShortcutsFile` import with new store loaders |
| `packages/app/src/components/panel/ShortcutsPanel.tsx` | Remove `loadTeamShortcutsFile` import + manual refresh; admin-only "visible to roles" picker (delegated to store) |
| `packages/app/src/components/sidebar/ShortcutsListColumn.tsx` | Remove `loadTeamShortcutsFile` import + refresh handler; call new store loader |
| `packages/app/src/components/chat/ChatPanel.tsx` | Remove `loadTeamShortcutsFile` call (replace with store loader) |
| `tests/functional/shortcuts-drag.test.ts` | Rewrite so it does not depend on `_meta/shortcuts.json` |

**Deleted files:**

| Path |
|---|
| `packages/app/src/lib/team-shortcuts.ts` |
| `packages/app/src/lib/__tests__/team-shortcuts.test.ts` |
| `packages/app/src/stores/__tests__/team-members-shortcuts-role.test.ts` |

**Not touched (intentional):**
- `apps/desktop/src/commands/gateway/mod.rs` `load_shortcuts`/`save_shortcuts` — they pass `Vec<serde_json::Value>` through, the new payload shape works without Rust changes. The on-disk schema bumps to `version: 2` from the frontend side (see Task 8).
- MCP server's path that reads `_meta/shortcuts.json` — tracked as risk in spec, follow-up plan.

---

## Phase 1 — Database

### Task 1: Migration — RBAC tables

**Files:**
- Create: `services/supabase/migrations/20260517100001_rbac_tables.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 20260517100001_rbac_tables.sql
-- Generic team-scoped RBAC. Shortcuts is the first consumer; channels/agents
-- can adopt the same `permissions` registry later.

create table public.team_roles (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  code text not null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, code)
);

create table public.team_member_roles (
  id uuid primary key default gen_random_uuid(),
  team_id   uuid not null references public.teams(id)      on delete cascade,
  member_id uuid not null references public.members(id)    on delete cascade,
  role_id   uuid not null references public.team_roles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (team_id, member_id, role_id)
);

create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  resource_type text not null,
  resource_id   uuid not null,
  code text not null,
  created_at timestamptz not null default now(),
  unique (team_id, resource_type, resource_id),
  unique (team_id, code)
);

create table public.permission_roles (
  id uuid primary key default gen_random_uuid(),
  permission_id uuid not null references public.permissions(id) on delete cascade,
  role_id       uuid not null references public.team_roles(id)  on delete cascade,
  created_at timestamptz not null default now(),
  unique (permission_id, role_id)
);

create index team_member_roles_member_idx on public.team_member_roles (team_id, member_id);
create index permissions_resource_idx     on public.permissions (team_id, resource_type, resource_id);
create index permission_roles_role_idx    on public.permission_roles (role_id);

alter table public.team_roles         enable row level security;
alter table public.team_member_roles  enable row level security;
alter table public.permissions        enable row level security;
alter table public.permission_roles   enable row level security;
```

- [ ] **Step 2: Apply locally and confirm**

```bash
supabase db reset --local
```

Expected: no errors; reset completes.

- [ ] **Step 3: Commit**

```bash
git add services/supabase/migrations/20260517100001_rbac_tables.sql
git commit -m "feat(db): add RBAC tables (team_roles, team_member_roles, permissions, permission_roles)"
```

---

### Task 2: Migration — shortcuts table

**Files:**
- Create: `services/supabase/migrations/20260517100002_shortcuts_table.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 20260517100002_shortcuts_table.sql
-- Personal + team shortcuts, tree via parent_id.
-- Visibility for team scope is governed by public.permissions (see RBAC tables).

create table public.shortcuts (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('personal','team')),
  owner_member_id uuid null references public.members(id) on delete cascade,
  team_id         uuid null references public.teams(id)    on delete cascade,
  parent_id       uuid null references public.shortcuts(id) on delete cascade,
  label text not null,
  icon text null,
  "order" int not null default 0,
  node_type text not null check (node_type in ('native','link','folder')),
  target text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shortcuts_scope_owner_xor check (
    (scope = 'personal' and owner_member_id is not null and team_id is null) or
    (scope = 'team'     and team_id        is not null and owner_member_id is null)
  )
);

create index shortcuts_personal_idx on public.shortcuts (owner_member_id) where scope = 'personal';
create index shortcuts_team_idx     on public.shortcuts (team_id)         where scope = 'team';
create index shortcuts_parent_idx   on public.shortcuts (parent_id);

alter table public.shortcuts enable row level security;
```

- [ ] **Step 2: Apply locally**

```bash
supabase db reset --local
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add services/supabase/migrations/20260517100002_shortcuts_table.sql
git commit -m "feat(db): add shortcuts table (scope-discriminated personal/team tree)"
```

---

### Task 3: Migration — RBAC + shortcut helpers

**Files:**
- Create: `services/supabase/migrations/20260517100003_rbac_shortcuts_helpers.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 20260517100003_rbac_shortcuts_helpers.sql
-- SECURITY DEFINER helpers used by RLS policies. They are explicitly
-- search_path-pinned (per services/supabase/migrations/202604220004_*).

create or replace function app.is_team_admin_or_owner(target_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app
as $$
  select app.current_team_role(target_team_id) in ('owner','admin')
$$;

-- Open default: if no permission_roles bindings exist for the permission,
-- every team member can see the underlying resource. Otherwise, the current
-- member must hold at least one bound role.
create or replace function app.member_can_access_permission(target_permission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app
as $$
  select case
    when not exists (
      select 1 from public.permission_roles where permission_id = target_permission_id
    ) then true
    else exists (
      select 1
      from public.permission_roles pr
      join public.team_member_roles tmr on tmr.role_id = pr.role_id
      where pr.permission_id = target_permission_id
        and tmr.member_id = app.current_member_id()
    )
  end
$$;

-- Visibility check used by shortcuts RLS for team-scope rows.
create or replace function app.member_can_see_shortcut(target_shortcut_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app
as $$
  with sc as (
    select scope, owner_member_id, team_id from public.shortcuts where id = target_shortcut_id
  )
  select case
    when (select scope from sc) = 'personal'
      then (select owner_member_id from sc) = app.current_member_id()
    when (select scope from sc) = 'team'
      then app.is_team_member((select team_id from sc))
       and app.member_can_access_permission((
         select id from public.permissions
         where team_id = (select team_id from sc)
           and resource_type = 'shortcut'
           and resource_id = target_shortcut_id
       ))
  end
$$;

revoke all on function app.is_team_admin_or_owner(uuid) from public;
revoke all on function app.member_can_access_permission(uuid) from public;
revoke all on function app.member_can_see_shortcut(uuid) from public;
grant execute on function app.is_team_admin_or_owner(uuid) to authenticated;
grant execute on function app.member_can_access_permission(uuid) to authenticated;
grant execute on function app.member_can_see_shortcut(uuid) to authenticated;
```

- [ ] **Step 2: Apply locally**

```bash
supabase db reset --local
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add services/supabase/migrations/20260517100003_rbac_shortcuts_helpers.sql
git commit -m "feat(db): RBAC + shortcut visibility helpers"
```

---

### Task 4: Migration — RLS policies

**Files:**
- Create: `services/supabase/migrations/20260517100004_rbac_shortcuts_rls.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 20260517100004_rbac_shortcuts_rls.sql

-- team_roles
create policy team_roles_select_if_member on public.team_roles
for select to authenticated
using (app.is_team_member(team_id));

create policy team_roles_write_if_admin on public.team_roles
for all to authenticated
using       (app.is_team_admin_or_owner(team_id))
with check  (app.is_team_admin_or_owner(team_id));

-- team_member_roles  (decision: SELECT open to all team members)
create policy team_member_roles_select_if_member on public.team_member_roles
for select to authenticated
using (app.is_team_member(team_id));

create policy team_member_roles_write_if_admin on public.team_member_roles
for all to authenticated
using       (app.is_team_admin_or_owner(team_id))
with check  (app.is_team_admin_or_owner(team_id));

-- permissions
create policy permissions_select_if_member on public.permissions
for select to authenticated
using (app.is_team_member(team_id));

create policy permissions_write_if_admin on public.permissions
for all to authenticated
using       (app.is_team_admin_or_owner(team_id))
with check  (app.is_team_admin_or_owner(team_id));

-- permission_roles  (team reached via permissions)
create policy permission_roles_select_if_member on public.permission_roles
for select to authenticated
using (exists (
  select 1 from public.permissions p
  where p.id = permission_roles.permission_id
    and app.is_team_member(p.team_id)
));

create policy permission_roles_write_if_admin on public.permission_roles
for all to authenticated
using (exists (
  select 1 from public.permissions p
  where p.id = permission_roles.permission_id
    and app.is_team_admin_or_owner(p.team_id)
))
with check (exists (
  select 1 from public.permissions p
  where p.id = permission_roles.permission_id
    and app.is_team_admin_or_owner(p.team_id)
));

-- shortcuts
create policy shortcuts_select_personal on public.shortcuts
for select to authenticated
using (
  scope = 'personal' and owner_member_id = app.current_member_id()
);

create policy shortcuts_select_team on public.shortcuts
for select to authenticated
using (
  scope = 'team' and app.member_can_see_shortcut(id)
);

create policy shortcuts_write_personal on public.shortcuts
for all to authenticated
using       (scope = 'personal' and owner_member_id = app.current_member_id())
with check  (scope = 'personal' and owner_member_id = app.current_member_id());

create policy shortcuts_write_team on public.shortcuts
for all to authenticated
using       (scope = 'team' and app.is_team_admin_or_owner(team_id))
with check  (scope = 'team' and app.is_team_admin_or_owner(team_id));
```

- [ ] **Step 2: Apply locally**

```bash
supabase db reset --local
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add services/supabase/migrations/20260517100004_rbac_shortcuts_rls.sql
git commit -m "feat(db): RLS policies for RBAC + shortcuts"
```

---

### Task 5: Migration — RPCs and cleanup trigger

**Files:**
- Create: `services/supabase/migrations/20260517100005_rbac_shortcuts_rpcs.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 20260517100005_rbac_shortcuts_rpcs.sql

-- 1) Create shortcut. Team scope also inserts the permissions registry row
--    in the same tx.
create or replace function public.shortcut_create(
  p_scope text,
  p_label text,
  p_node_type text,
  p_team_id uuid default null,
  p_parent_id uuid default null,
  p_icon text default null,
  p_order int default 0,
  p_target text default ''
) returns uuid
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_id uuid;
  v_member uuid := app.current_member_id();
begin
  if v_member is null then
    raise exception 'not authenticated';
  end if;

  if p_scope = 'personal' then
    insert into public.shortcuts (scope, owner_member_id, parent_id, label, icon, "order", node_type, target)
    values ('personal', v_member, p_parent_id, p_label, p_icon, p_order, p_node_type, p_target)
    returning id into v_id;
  elsif p_scope = 'team' then
    if p_team_id is null then
      raise exception 'team_id required for team scope';
    end if;
    if not app.is_team_admin_or_owner(p_team_id) then
      raise exception 'forbidden';
    end if;
    insert into public.shortcuts (scope, team_id, parent_id, label, icon, "order", node_type, target)
    values ('team', p_team_id, p_parent_id, p_label, p_icon, p_order, p_node_type, p_target)
    returning id into v_id;
    insert into public.permissions (team_id, resource_type, resource_id, code)
    values (p_team_id, 'shortcut', v_id, 'shortcut:' || v_id::text);
  else
    raise exception 'invalid scope: %', p_scope;
  end if;

  return v_id;
end $$;

-- 2) Drag/drop batch reorder. Single tx.
create or replace function public.shortcut_batch_move(
  p_moves jsonb   -- [{"id":"...","parent_id":"..."|null,"order":3}, ...]
) returns int
language plpgsql
security definer
set search_path = public, app
as $$
declare v_count int;
begin
  update public.shortcuts s set
    parent_id  = nullif(m->>'parent_id','')::uuid,
    "order"    = (m->>'order')::int,
    updated_at = now()
  from jsonb_array_elements(p_moves) m
  where s.id = (m->>'id')::uuid
    and (
      (s.scope = 'personal' and s.owner_member_id = app.current_member_id())
      or (s.scope = 'team'  and app.is_team_admin_or_owner(s.team_id))
    );
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- 3) Set the FULL set of roles that can see a team shortcut (swap-in).
create or replace function public.shortcut_set_visible_roles(
  p_shortcut_id uuid,
  p_role_ids uuid[]
) returns void
language plpgsql
security definer
set search_path = public, app
as $$
declare v_team uuid; v_perm uuid;
begin
  select team_id into v_team from public.shortcuts
    where id = p_shortcut_id and scope = 'team';
  if v_team is null then
    raise exception 'shortcut not found or not team-scoped';
  end if;
  if not app.is_team_admin_or_owner(v_team) then
    raise exception 'forbidden';
  end if;
  select id into v_perm from public.permissions
    where team_id = v_team and resource_type = 'shortcut' and resource_id = p_shortcut_id;
  if v_perm is null then
    raise exception 'permission row missing for shortcut %', p_shortcut_id;
  end if;
  delete from public.permission_roles where permission_id = v_perm;
  if array_length(p_role_ids, 1) is not null then
    insert into public.permission_roles (permission_id, role_id)
      select v_perm, unnest(p_role_ids);
  end if;
end $$;

-- 4) Set the FULL set of custom roles a member holds (swap-in).
create or replace function public.team_member_set_roles(
  p_team_id uuid,
  p_member_id uuid,
  p_role_ids uuid[]
) returns void
language plpgsql
security definer
set search_path = public, app
as $$
begin
  if not app.is_team_admin_or_owner(p_team_id) then
    raise exception 'forbidden';
  end if;
  delete from public.team_member_roles
    where team_id = p_team_id and member_id = p_member_id;
  if array_length(p_role_ids, 1) is not null then
    insert into public.team_member_roles (team_id, member_id, role_id)
      select p_team_id, p_member_id, unnest(p_role_ids);
  end if;
end $$;

-- Trigger: when a team shortcut is deleted, also delete its permissions row.
-- (No FK in that direction since permissions is polymorphic via resource_id.)
create or replace function app.cleanup_shortcut_permission()
returns trigger
language plpgsql
security definer
set search_path = public, app
as $$
begin
  if old.scope = 'team' then
    delete from public.permissions
      where team_id = old.team_id
        and resource_type = 'shortcut'
        and resource_id = old.id;
  end if;
  return old;
end $$;

create trigger shortcuts_cleanup_permission_after_delete
  after delete on public.shortcuts
  for each row execute function app.cleanup_shortcut_permission();

revoke all on function public.shortcut_create(text,text,text,uuid,uuid,text,int,text)        from public;
revoke all on function public.shortcut_batch_move(jsonb)                                     from public;
revoke all on function public.shortcut_set_visible_roles(uuid,uuid[])                        from public;
revoke all on function public.team_member_set_roles(uuid,uuid,uuid[])                        from public;
grant execute on function public.shortcut_create(text,text,text,uuid,uuid,text,int,text)     to authenticated;
grant execute on function public.shortcut_batch_move(jsonb)                                  to authenticated;
grant execute on function public.shortcut_set_visible_roles(uuid,uuid[])                     to authenticated;
grant execute on function public.team_member_set_roles(uuid,uuid,uuid[])                     to authenticated;
```

- [ ] **Step 2: Apply locally**

```bash
supabase db reset --local
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add services/supabase/migrations/20260517100005_rbac_shortcuts_rpcs.sql
git commit -m "feat(db): shortcut RPCs (create/batch_move/set_visible_roles/team_member_set_roles) + cleanup trigger"
```

---

### Task 6: pgTAP tests for schema, helpers, RLS, RPCs

**Files:**
- Create: `services/supabase/tests/015_rbac_shortcuts.sql`

This test file follows the existing pattern in `services/supabase/tests/002_rls.sql` (multi-user fixtures using `set local request.jwt.claims`). The plan count must match the assertion count.

- [ ] **Step 1: Write the test file in full**

```sql
-- services/supabase/tests/015_rbac_shortcuts.sql
begin;

select plan(22);

-- ── Fixture setup ────────────────────────────────────────────────────────
-- One team. owner is the team owner; m1 and m2 are plain members.
-- Custom role 'sales' is held by m1 only.

create temp table fx(
  team_id uuid,
  owner_member uuid, owner_user uuid,
  m1_member uuid, m1_user uuid,
  m2_member uuid, m2_user uuid,
  role_sales uuid
) on commit drop;

create or replace function pg_temp.mk_member(p_team uuid, p_name text, p_role text)
returns table(member_id uuid, user_id uuid)
language plpgsql as $$
declare v_actor uuid := gen_random_uuid(); v_user uuid := gen_random_uuid();
begin
  insert into auth.users(id, email) values (v_user, p_name || '@test.local');
  insert into public.actors(id, team_id, actor_type, display_name)
    values (v_actor, p_team, 'member', p_name);
  insert into public.members(id, user_id, status)
    values (v_actor, v_user, 'active');
  insert into public.team_members(team_id, member_id, role)
    values (p_team, v_actor, p_role);
  return query select v_actor, v_user;
end $$;

create or replace function pg_temp.as_user(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function pg_temp.as_service() returns void
language plpgsql as $$
begin
  perform set_config('role', 'service_role', true);
end $$;

-- Seed
insert into fx(team_id) values (gen_random_uuid());
insert into public.teams(id, slug, name)
  select team_id, 'team-' || team_id::text, 'T' from fx;

update fx set (owner_member, owner_user) =
  (select member_id, user_id from pg_temp.mk_member((select team_id from fx), 'owner', 'owner'));
update fx set (m1_member, m1_user) =
  (select member_id, user_id from pg_temp.mk_member((select team_id from fx), 'm1', 'member'));
update fx set (m2_member, m2_user) =
  (select member_id, user_id from pg_temp.mk_member((select team_id from fx), 'm2', 'member'));

-- Owner creates the 'sales' role and assigns it to m1.
select pg_temp.as_user((select owner_user from fx));

insert into public.team_roles(team_id, code, name)
  select team_id, 'sales', 'Sales' from fx;
update fx set role_sales = (
  select id from public.team_roles
  where team_id = fx.team_id and code = 'sales'
);

insert into public.team_member_roles(team_id, member_id, role_id)
  select team_id, m1_member, role_sales from fx;

-- ── 1) Schema-level ─────────────────────────────────────────────────────
select has_table('public','team_roles',         'team_roles exists');
select has_table('public','team_member_roles',  'team_member_roles exists');
select has_table('public','permissions',        'permissions exists');
select has_table('public','permission_roles',   'permission_roles exists');
select has_table('public','shortcuts',          'shortcuts exists');

-- 2) XOR constraint: personal with no owner_member_id is rejected
select pg_temp.as_service();
select throws_ok(
  $$ insert into public.shortcuts(scope, label, node_type) values ('personal','x','link') $$,
  '23514',
  null,
  'XOR rejects personal shortcut with no owner_member_id'
);

-- 3) XOR constraint: team with both owner_member_id and team_id is rejected
select throws_ok(
  $$ insert into public.shortcuts(scope, owner_member_id, team_id, label, node_type)
     values ('team', gen_random_uuid(), gen_random_uuid(), 'x', 'link') $$,
  '23514',
  null,
  'XOR rejects team shortcut with owner_member_id set'
);

-- ── Helpers exist ───────────────────────────────────────────────────────
-- 4-6
select lives_ok(
  $$ select app.is_team_admin_or_owner(gen_random_uuid()) $$,
  'helper: is_team_admin_or_owner'
);
select lives_ok(
  $$ select app.member_can_access_permission(gen_random_uuid()) $$,
  'helper: member_can_access_permission'
);
select lives_ok(
  $$ select app.member_can_see_shortcut(gen_random_uuid()) $$,
  'helper: member_can_see_shortcut'
);

-- ── RPC: shortcut_create personal ───────────────────────────────────────
select pg_temp.as_user((select m1_user from fx));

select lives_ok(
  $$ select public.shortcut_create('personal', 'My Link', 'link', null, null, null, 0, 'https://example.com') $$,
  'rpc: shortcut_create personal succeeds for any member'
);  -- 7

-- ── RPC: shortcut_create team forbidden for non-admin ───────────────────
select throws_ok(
  $$ select public.shortcut_create('team', 'Team Link', 'link',
       (select team_id from fx), null, null, 0, 'https://example.com') $$,
  null,
  'forbidden',
  'rpc: shortcut_create team rejects non-admin'
);  -- 8

-- ── RPC: shortcut_create team succeeds for owner; also creates permission row
select pg_temp.as_user((select owner_user from fx));

select lives_ok(
  $$ select public.shortcut_create('team', 'Team Link', 'link',
       (select team_id from fx), null, null, 0, 'https://example.com') $$,
  'rpc: shortcut_create team succeeds for owner'
);  -- 9

select pg_temp.as_service();
select is(
  (select count(*)::int from public.permissions
    where team_id = (select team_id from fx) and resource_type = 'shortcut'),
  1,
  'permissions row inserted for team shortcut'
);  -- 10

-- ── RLS: personal isolation ─────────────────────────────────────────────
select pg_temp.as_user((select m2_user from fx));

select is(
  (select count(*)::int from public.shortcuts
    where scope = 'personal'),
  0,
  'm2 cannot see m1''s personal shortcut'
);  -- 11

select pg_temp.as_user((select m1_user from fx));
select is(
  (select count(*)::int from public.shortcuts where scope = 'personal'),
  1,
  'm1 sees own personal shortcut'
);  -- 12

-- ── RLS: team open default (no permission_roles bindings) ───────────────
select pg_temp.as_user((select m2_user from fx));
select is(
  (select count(*)::int from public.shortcuts where scope = 'team'),
  1,
  'm2 (no roles) sees team shortcut under open default'
);  -- 13

-- ── RPC: shortcut_set_visible_roles binds 'sales' to the team shortcut ──
select pg_temp.as_user((select owner_user from fx));

select lives_ok(
  $$ select public.shortcut_set_visible_roles(
       (select id from public.shortcuts where scope='team' limit 1),
       array[(select role_sales from fx)]
     ) $$,
  'rpc: shortcut_set_visible_roles binds sales role'
);  -- 14

-- ── RLS: team restricted — m2 (no sales) cannot see; m1 (sales) can ─────
select pg_temp.as_user((select m2_user from fx));
select is(
  (select count(*)::int from public.shortcuts where scope = 'team'),
  0,
  'm2 cannot see team shortcut after sales-only binding'
);  -- 15

select pg_temp.as_user((select m1_user from fx));
select is(
  (select count(*)::int from public.shortcuts where scope = 'team'),
  1,
  'm1 (holds sales) can see team shortcut after binding'
);  -- 16

-- ── RPC: shortcut_set_visible_roles swap-in (replace bindings) ──────────
select pg_temp.as_user((select owner_user from fx));

select lives_ok(
  $$ select public.shortcut_set_visible_roles(
       (select id from public.shortcuts where scope='team' limit 1),
       array[]::uuid[]
     ) $$,
  'rpc: shortcut_set_visible_roles can clear bindings (back to open default)'
);  -- 17

select pg_temp.as_service();
select is(
  (select count(*)::int from public.permission_roles
    where permission_id = (
      select id from public.permissions
      where resource_type = 'shortcut'
        and resource_id = (select id from public.shortcuts where scope='team' limit 1)
    )),
  0,
  'permission_roles cleared after swap-in with empty array'
);  -- 18

-- ── Trigger: deleting a team shortcut cleans up its permissions row ─────
select pg_temp.as_user((select owner_user from fx));
delete from public.shortcuts
  where scope = 'team' and team_id = (select team_id from fx);

select pg_temp.as_service();
select is(
  (select count(*)::int from public.permissions
    where team_id = (select team_id from fx) and resource_type = 'shortcut'),
  0,
  'cleanup trigger removes permissions row after team shortcut delete'
);  -- 19

-- ── RPC: team_member_set_roles swap-in ──────────────────────────────────
select pg_temp.as_user((select owner_user from fx));

select lives_ok(
  $$ select public.team_member_set_roles(
       (select team_id from fx),
       (select m2_member from fx),
       array[(select role_sales from fx)]
     ) $$,
  'rpc: team_member_set_roles assigns sales to m2'
);  -- 20

select pg_temp.as_service();
select is(
  (select count(*)::int from public.team_member_roles
    where member_id = (select m2_member from fx)),
  1,
  'm2 now has one role binding'
);  -- 21

-- Swap-in to empty
select pg_temp.as_user((select owner_user from fx));
select public.team_member_set_roles(
  (select team_id from fx),
  (select m2_member from fx),
  array[]::uuid[]
);

select pg_temp.as_service();
select is(
  (select count(*)::int from public.team_member_roles
    where member_id = (select m2_member from fx)),
  0,
  'team_member_set_roles with empty array clears all bindings'
);  -- 22

select * from finish();
rollback;
```

> Implementer note: the assertion count must equal `plan(22)`. If you reshape any block, recount and update the `plan(...)` call.

- [ ] **Step 2: Run the pgTAP tests**

```bash
supabase test db --local
```

Expected: 22/22 pass.

- [ ] **Step 3: Commit**

```bash
git add services/supabase/tests/015_rbac_shortcuts.sql
git commit -m "test(db): pgTAP for RBAC + shortcuts schema/RLS/RPCs"
```

---

## Phase 2 — Front-end client layer

### Task 7: RPC + query wrappers in `lib/shortcuts-rpc.ts`

**Files:**
- Create: `packages/app/src/lib/shortcuts-rpc.ts`
- Create: `packages/app/src/lib/__tests__/shortcuts-rpc.test.ts`

- [ ] **Step 1: Write the test file (red)**

```typescript
// packages/app/src/lib/__tests__/shortcuts-rpc.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRpc = vi.fn()
const mockFrom = vi.fn()
vi.mock('@/lib/supabase-client', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  },
}))

import {
  rpcShortcutCreate,
  rpcShortcutBatchMove,
  rpcShortcutSetVisibleRoles,
  selectShortcuts,
  ShortcutsRpcError,
} from '@/lib/shortcuts-rpc'

beforeEach(() => {
  mockRpc.mockReset()
  mockFrom.mockReset()
})

describe('rpcShortcutCreate', () => {
  it('calls shortcut_create RPC with named args for personal scope', async () => {
    mockRpc.mockResolvedValue({ data: 'new-uuid', error: null })
    const id = await rpcShortcutCreate({
      scope: 'personal',
      label: 'My Link',
      nodeType: 'link',
      parentId: null,
      icon: null,
      order: 0,
      target: 'https://example.com',
    })
    expect(id).toBe('new-uuid')
    expect(mockRpc).toHaveBeenCalledWith('shortcut_create', {
      p_scope: 'personal',
      p_label: 'My Link',
      p_node_type: 'link',
      p_team_id: null,
      p_parent_id: null,
      p_icon: null,
      p_order: 0,
      p_target: 'https://example.com',
    })
  })

  it('throws ShortcutsRpcError when RPC errors', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'forbidden', code: 'P0001' } })
    await expect(rpcShortcutCreate({
      scope: 'team',
      teamId: 'team-uuid',
      label: 'L',
      nodeType: 'link',
      parentId: null,
      icon: null,
      order: 0,
      target: '',
    })).rejects.toThrow(ShortcutsRpcError)
  })
})

describe('rpcShortcutBatchMove', () => {
  it('sends jsonb-shaped moves array', async () => {
    mockRpc.mockResolvedValue({ data: 3, error: null })
    const count = await rpcShortcutBatchMove([
      { id: 'a', parentId: null, order: 0 },
      { id: 'b', parentId: 'a',  order: 1 },
    ])
    expect(count).toBe(3)
    expect(mockRpc).toHaveBeenCalledWith('shortcut_batch_move', {
      p_moves: [
        { id: 'a', parent_id: null, order: 0 },
        { id: 'b', parent_id: 'a',  order: 1 },
      ],
    })
  })
})

describe('rpcShortcutSetVisibleRoles', () => {
  it('forwards shortcut_id and role_ids', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null })
    await rpcShortcutSetVisibleRoles('shortcut-uuid', ['role-1', 'role-2'])
    expect(mockRpc).toHaveBeenCalledWith('shortcut_set_visible_roles', {
      p_shortcut_id: 'shortcut-uuid',
      p_role_ids: ['role-1', 'role-2'],
    })
  })
})

describe('selectShortcuts', () => {
  it('queries shortcuts by scope and maps DB rows to ShortcutNode', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq:     vi.fn().mockReturnThis(),
      order:  vi.fn().mockResolvedValue({
        data: [{
          id: 'a', scope: 'personal', owner_member_id: 'm1', team_id: null,
          parent_id: null, label: 'L', icon: null, order: 0,
          node_type: 'link', target: 't', created_at: '2026-01-01', updated_at: '2026-01-01',
        }],
        error: null,
      }),
    }
    mockFrom.mockReturnValue(chain)
    const rows = await selectShortcuts({ scope: 'personal' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'a', label: 'L', type: 'link', target: 't', parentId: null, order: 0,
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test:unit -- packages/app/src/lib/__tests__/shortcuts-rpc.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/app/src/lib/shortcuts-rpc.ts
import { supabase } from '@/lib/supabase-client'

export type ShortcutScope = 'personal' | 'team'
export type ShortcutNodeType = 'native' | 'link' | 'folder'

export interface ShortcutNode {
  id: string
  scope: ShortcutScope
  ownerMemberId: string | null
  teamId: string | null
  parentId: string | null
  label: string
  icon: string | null
  order: number
  type: ShortcutNodeType
  target: string
  createdAt: string
  updatedAt: string
  children?: ShortcutNode[]
}

export interface TeamRole {
  id: string
  teamId: string
  code: string
  name: string
}

export class ShortcutsRpcError extends Error {
  constructor(public readonly code: string | null, message: string) {
    super(message)
    this.name = 'ShortcutsRpcError'
  }
}

function rowToNode(row: Record<string, unknown>): ShortcutNode {
  return {
    id:            row.id as string,
    scope:         row.scope as ShortcutScope,
    ownerMemberId: (row.owner_member_id as string | null) ?? null,
    teamId:        (row.team_id as string | null) ?? null,
    parentId:      (row.parent_id as string | null) ?? null,
    label:         row.label as string,
    icon:          (row.icon as string | null) ?? null,
    order:         row.order as number,
    type:          row.node_type as ShortcutNodeType,
    target:        (row.target as string) ?? '',
    createdAt:     row.created_at as string,
    updatedAt:     row.updated_at as string,
  }
}

export async function selectShortcuts(opts: {
  scope: ShortcutScope
  teamId?: string
}): Promise<ShortcutNode[]> {
  let q = supabase.from('shortcuts').select('*').eq('scope', opts.scope)
  if (opts.scope === 'team' && opts.teamId) q = q.eq('team_id', opts.teamId)
  const { data, error } = await q.order('order', { ascending: true })
  if (error) throw new ShortcutsRpcError(error.code ?? null, error.message)
  return (data ?? []).map(rowToNode)
}

export interface ShortcutCreateInput {
  scope: ShortcutScope
  teamId?: string
  label: string
  nodeType: ShortcutNodeType
  parentId: string | null
  icon: string | null
  order: number
  target: string
}

export async function rpcShortcutCreate(input: ShortcutCreateInput): Promise<string> {
  const { data, error } = await supabase.rpc('shortcut_create', {
    p_scope:     input.scope,
    p_label:     input.label,
    p_node_type: input.nodeType,
    p_team_id:   input.scope === 'team' ? (input.teamId ?? null) : null,
    p_parent_id: input.parentId,
    p_icon:      input.icon,
    p_order:     input.order,
    p_target:    input.target,
  })
  if (error) throw new ShortcutsRpcError(error.code ?? null, error.message)
  return data as string
}

export async function rpcShortcutUpdate(
  id: string,
  patch: Partial<Pick<ShortcutNode, 'label' | 'icon' | 'target' | 'order' | 'parentId'>>,
): Promise<void> {
  const dbPatch: Record<string, unknown> = {}
  if (patch.label    !== undefined) dbPatch.label     = patch.label
  if (patch.icon     !== undefined) dbPatch.icon      = patch.icon
  if (patch.target   !== undefined) dbPatch.target    = patch.target
  if (patch.order    !== undefined) dbPatch.order     = patch.order
  if (patch.parentId !== undefined) dbPatch.parent_id = patch.parentId
  dbPatch.updated_at = new Date().toISOString()
  const { error } = await supabase.from('shortcuts').update(dbPatch).eq('id', id)
  if (error) throw new ShortcutsRpcError(error.code ?? null, error.message)
}

export async function rpcShortcutDelete(id: string): Promise<void> {
  const { error } = await supabase.from('shortcuts').delete().eq('id', id)
  if (error) throw new ShortcutsRpcError(error.code ?? null, error.message)
}

export interface ShortcutMove {
  id: string
  parentId: string | null
  order: number
}

export async function rpcShortcutBatchMove(moves: ShortcutMove[]): Promise<number> {
  const { data, error } = await supabase.rpc('shortcut_batch_move', {
    p_moves: moves.map(m => ({ id: m.id, parent_id: m.parentId, order: m.order })),
  })
  if (error) throw new ShortcutsRpcError(error.code ?? null, error.message)
  return data as number
}

export async function rpcShortcutSetVisibleRoles(
  shortcutId: string,
  roleIds: string[],
): Promise<void> {
  const { error } = await supabase.rpc('shortcut_set_visible_roles', {
    p_shortcut_id: shortcutId,
    p_role_ids: roleIds,
  })
  if (error) throw new ShortcutsRpcError(error.code ?? null, error.message)
}

export async function selectTeamRoles(teamId: string): Promise<TeamRole[]> {
  const { data, error } = await supabase
    .from('team_roles')
    .select('id, team_id, code, name')
    .eq('team_id', teamId)
    .order('code', { ascending: true })
  if (error) throw new ShortcutsRpcError(error.code ?? null, error.message)
  return (data ?? []).map(r => ({ id: r.id, teamId: r.team_id, code: r.code, name: r.name }))
}

export async function selectShortcutRoleBindings(teamId: string): Promise<Map<string, string[]>> {
  // Returns shortcut_id → role_id[] for the given team. Uses permissions ⨝ permission_roles.
  const { data, error } = await supabase
    .from('permissions')
    .select('resource_id, permission_roles(role_id)')
    .eq('team_id', teamId)
    .eq('resource_type', 'shortcut')
  if (error) throw new ShortcutsRpcError(error.code ?? null, error.message)
  const m = new Map<string, string[]>()
  for (const p of (data ?? []) as Array<{ resource_id: string; permission_roles: Array<{ role_id: string }> }>) {
    m.set(p.resource_id, p.permission_roles.map(pr => pr.role_id))
  }
  return m
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test:unit -- packages/app/src/lib/__tests__/shortcuts-rpc.test.ts
```

Expected: PASS — all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/lib/shortcuts-rpc.ts packages/app/src/lib/__tests__/shortcuts-rpc.test.ts
git commit -m "feat(shortcuts): typed Supabase RPC + query wrappers"
```

---

### Task 8: Rewrite `stores/shortcuts.ts`

**Files:**
- Modify: `packages/app/src/stores/shortcuts.ts` (full rewrite)
- Modify: `packages/app/src/stores/__tests__/shortcuts.test.ts` (full rewrite)

- [ ] **Step 1: Write the new test file (red)**

```typescript
// packages/app/src/stores/__tests__/shortcuts.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInvoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => mockInvoke(...a) }))

const mockSelectShortcuts = vi.fn()
const mockRpcCreate       = vi.fn()
const mockRpcUpdate       = vi.fn()
const mockRpcDelete       = vi.fn()
const mockRpcBatchMove    = vi.fn()
vi.mock('@/lib/shortcuts-rpc', () => ({
  selectShortcuts:     (...a: unknown[]) => mockSelectShortcuts(...a),
  rpcShortcutCreate:   (...a: unknown[]) => mockRpcCreate(...a),
  rpcShortcutUpdate:   (...a: unknown[]) => mockRpcUpdate(...a),
  rpcShortcutDelete:   (...a: unknown[]) => mockRpcDelete(...a),
  rpcShortcutBatchMove:(...a: unknown[]) => mockRpcBatchMove(...a),
  ShortcutsRpcError: class extends Error {},
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: { getState: () => ({ workspacePath: '/ws' }) },
}))

import { useShortcutsStore } from '@/stores/shortcuts'

beforeEach(() => {
  vi.clearAllMocks()
  useShortcutsStore.setState({
    personalNodes: [],
    teamNodes: [],
    loading: false,
    loadedAt: null,
    teamRoles: null,
    shortcutVisibility: null,
  })
})

describe('useShortcutsStore', () => {
  it('loadPersonal fetches via selectShortcuts and persists cache', async () => {
    mockSelectShortcuts.mockResolvedValue([
      { id: 'a', scope: 'personal', label: 'A', type: 'link', target: 't', parentId: null,
        order: 0, ownerMemberId: 'm', teamId: null, icon: null, createdAt: '', updatedAt: '' },
    ])
    mockInvoke.mockResolvedValue(undefined)
    await useShortcutsStore.getState().loadPersonal()
    expect(useShortcutsStore.getState().personalNodes).toHaveLength(1)
    expect(mockInvoke).toHaveBeenCalledWith('save_shortcuts', expect.objectContaining({
      workspacePath: '/ws',
      nodes: expect.any(Array),
    }))
  })

  it('addNode calls rpcShortcutCreate then re-fetches the affected scope', async () => {
    mockRpcCreate.mockResolvedValue('new-id')
    mockSelectShortcuts.mockResolvedValue([])
    mockInvoke.mockResolvedValue(undefined)
    const id = await useShortcutsStore.getState().addNode('personal', {
      label: 'L', type: 'link', target: 't', parentId: null, icon: null, order: 0,
    })
    expect(id).toBe('new-id')
    expect(mockRpcCreate).toHaveBeenCalledOnce()
    expect(mockSelectShortcuts).toHaveBeenCalledWith({ scope: 'personal' })
  })

  it('addNode does not update state on RPC failure', async () => {
    mockRpcCreate.mockRejectedValue(new Error('forbidden'))
    await expect(useShortcutsStore.getState().addNode('team', {
      label: 'L', type: 'link', target: 't', parentId: null, icon: null, order: 0,
    })).rejects.toThrow('forbidden')
    expect(useShortcutsStore.getState().teamNodes).toHaveLength(0)
  })

  it('deleteNode calls rpcShortcutDelete then re-fetches', async () => {
    mockRpcDelete.mockResolvedValue(undefined)
    mockSelectShortcuts.mockResolvedValue([])
    useShortcutsStore.setState({
      personalNodes: [{ id: 'a', scope: 'personal', label: 'A', type: 'link', target: 't',
        parentId: null, order: 0, ownerMemberId: 'm', teamId: null, icon: null,
        createdAt: '', updatedAt: '' }],
    })
    await useShortcutsStore.getState().deleteNode('a')
    expect(mockRpcDelete).toHaveBeenCalledWith('a')
    expect(mockSelectShortcuts).toHaveBeenCalled()
  })

  it('batchMove calls rpcShortcutBatchMove and re-fetches', async () => {
    mockRpcBatchMove.mockResolvedValue(2)
    mockSelectShortcuts.mockResolvedValue([])
    await useShortcutsStore.getState().batchMove([
      { id: 'a', parentId: null, order: 0 },
      { id: 'b', parentId: 'a',  order: 1 },
    ])
    expect(mockRpcBatchMove).toHaveBeenCalledOnce()
  })

  it('getTree returns personal + team trees combined', () => {
    useShortcutsStore.setState({
      personalNodes: [
        { id: 'p1', scope: 'personal', label: 'P1', type: 'link', target: 't', parentId: null,
          order: 0, ownerMemberId: 'm', teamId: null, icon: null, createdAt: '', updatedAt: '' },
      ],
      teamNodes: [
        { id: 't1', scope: 'team', label: 'T1', type: 'link', target: 't', parentId: null,
          order: 0, ownerMemberId: null, teamId: 'team-1', icon: null, createdAt: '', updatedAt: '' },
      ],
    })
    expect(useShortcutsStore.getState().getTree()).toHaveLength(2)
  })

  it('on launch cache hydration: loads cache via load_shortcuts before network', async () => {
    mockInvoke.mockResolvedValueOnce([
      { id: 'cache-id', scope: 'personal', label: 'Cached', node_type: 'link', target: 't',
        parent_id: null, order: 0, owner_member_id: 'm', team_id: null, icon: null,
        created_at: '', updated_at: '' },
    ])
    await useShortcutsStore.getState().hydrateFromCache()
    expect(useShortcutsStore.getState().personalNodes).toHaveLength(1)
    expect(useShortcutsStore.getState().personalNodes[0].label).toBe('Cached')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test:unit -- packages/app/src/stores/__tests__/shortcuts.test.ts
```

Expected: FAIL — symbol mismatches.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/app/src/stores/shortcuts.ts
import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import {
  selectShortcuts,
  rpcShortcutCreate,
  rpcShortcutUpdate,
  rpcShortcutDelete,
  rpcShortcutBatchMove,
  rpcShortcutSetVisibleRoles,
  selectTeamRoles,
  selectShortcutRoleBindings,
  type ShortcutNode,
  type ShortcutScope,
  type ShortcutNodeType,
  type TeamRole,
} from '@/lib/shortcuts-rpc'
import { useWorkspaceStore } from './workspace'

export type { ShortcutNode, TeamRole } from '@/lib/shortcuts-rpc'

export interface NewShortcutInput {
  label: string
  type: ShortcutNodeType
  target: string
  parentId: string | null
  icon: string | null
  order: number
}

interface ShortcutsState {
  personalNodes: ShortcutNode[]
  teamNodes: ShortcutNode[]
  loading: boolean
  loadedAt: number | null

  teamRoles: TeamRole[] | null
  shortcutVisibility: Map<string, string[]> | null

  loadPersonal: () => Promise<void>
  loadTeamForCurrentTeam: (teamId: string | null) => Promise<void>
  hydrateFromCache: () => Promise<void>

  addNode:    (scope: ShortcutScope, input: NewShortcutInput, teamId?: string) => Promise<string>
  updateNode: (id: string, patch: Partial<Pick<ShortcutNode,'label'|'icon'|'target'|'order'|'parentId'>>) => Promise<void>
  deleteNode: (id: string) => Promise<void>
  batchMove:  (moves: Array<{ id: string; parentId: string | null; order: number }>) => Promise<void>

  loadTeamRoles:    (teamId: string) => Promise<void>
  setVisibleRoles:  (shortcutId: string, roleIds: string[]) => Promise<void>

  getTree: () => ShortcutNode[]
  getChildren: (parentId: string | null) => ShortcutNode[]
}

// ── Cache helpers (Tauri-backed JSON file, version 2) ──────────────────

const CACHE_VERSION = 2

function getWorkspaceArgs(): { workspacePath?: string } {
  const wp = useWorkspaceStore.getState().workspacePath
  return wp ? { workspacePath: wp } : {}
}

interface CacheRow {
  id: string
  scope: ShortcutScope
  owner_member_id: string | null
  team_id: string | null
  parent_id: string | null
  label: string
  icon: string | null
  order: number
  node_type: ShortcutNodeType
  target: string
  created_at: string
  updated_at: string
  __version?: number
}

function nodeToCache(n: ShortcutNode): CacheRow {
  return {
    id: n.id,
    scope: n.scope,
    owner_member_id: n.ownerMemberId,
    team_id: n.teamId,
    parent_id: n.parentId,
    label: n.label,
    icon: n.icon,
    order: n.order,
    node_type: n.type,
    target: n.target,
    created_at: n.createdAt,
    updated_at: n.updatedAt,
    __version: CACHE_VERSION,
  }
}

function cacheToNode(r: CacheRow): ShortcutNode {
  return {
    id: r.id,
    scope: r.scope,
    ownerMemberId: r.owner_member_id,
    teamId: r.team_id,
    parentId: r.parent_id,
    label: r.label,
    icon: r.icon,
    order: r.order,
    type: r.node_type,
    target: r.target,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

async function persistCache(nodes: ShortcutNode[]): Promise<void> {
  try {
    await invoke('save_shortcuts', {
      ...getWorkspaceArgs(),
      nodes: nodes.map(nodeToCache),
    })
  } catch { /* best-effort */ }
}

async function readCache(): Promise<ShortcutNode[]> {
  try {
    const raw = await invoke<CacheRow[]>('load_shortcuts', getWorkspaceArgs())
    if (!Array.isArray(raw)) return []
    // Drop rows that look like legacy v1 (no `scope` field) — clean break.
    return raw.filter(r => r && (r as { scope?: unknown }).scope).map(cacheToNode)
  } catch {
    return []
  }
}

// ── Tree helpers ───────────────────────────────────────────────────────

function buildTree(nodes: ShortcutNode[], parentId: string | null): ShortcutNode[] {
  return nodes
    .filter(n => n.parentId === parentId)
    .sort((a, b) => a.order - b.order)
    .map(n => ({ ...n, children: buildTree(nodes, n.id) }))
}

// ── Store ──────────────────────────────────────────────────────────────

export const useShortcutsStore = create<ShortcutsState>((set, get) => ({
  personalNodes: [],
  teamNodes: [],
  loading: false,
  loadedAt: null,
  teamRoles: null,
  shortcutVisibility: null,

  hydrateFromCache: async () => {
    const cached = await readCache()
    if (cached.length === 0) return
    set({
      personalNodes: cached.filter(n => n.scope === 'personal'),
      teamNodes:     cached.filter(n => n.scope === 'team'),
    })
  },

  loadPersonal: async () => {
    set({ loading: true })
    try {
      const rows = await selectShortcuts({ scope: 'personal' })
      set({ personalNodes: rows, loadedAt: Date.now() })
      await persistCache([...rows, ...get().teamNodes])
    } finally {
      set({ loading: false })
    }
  },

  loadTeamForCurrentTeam: async (teamId) => {
    if (!teamId) { set({ teamNodes: [] }); return }
    set({ loading: true })
    try {
      const rows = await selectShortcuts({ scope: 'team', teamId })
      set({ teamNodes: rows, loadedAt: Date.now() })
      await persistCache([...get().personalNodes, ...rows])
    } finally {
      set({ loading: false })
    }
  },

  addNode: async (scope, input, teamId) => {
    const id = await rpcShortcutCreate({
      scope,
      teamId: scope === 'team' ? teamId : undefined,
      label: input.label,
      nodeType: input.type,
      parentId: input.parentId,
      icon: input.icon,
      order: input.order,
      target: input.target,
    })
    if (scope === 'personal') await get().loadPersonal()
    else                       await get().loadTeamForCurrentTeam(teamId ?? null)
    return id
  },

  updateNode: async (id, patch) => {
    await rpcShortcutUpdate(id, patch)
    const node = [...get().personalNodes, ...get().teamNodes].find(n => n.id === id)
    if (node?.scope === 'personal') await get().loadPersonal()
    else if (node?.scope === 'team') await get().loadTeamForCurrentTeam(node.teamId)
  },

  deleteNode: async (id) => {
    const node = [...get().personalNodes, ...get().teamNodes].find(n => n.id === id)
    await rpcShortcutDelete(id)
    if (node?.scope === 'personal') await get().loadPersonal()
    else if (node?.scope === 'team') await get().loadTeamForCurrentTeam(node.teamId)
  },

  batchMove: async (moves) => {
    await rpcShortcutBatchMove(moves)
    // After a batch move we don't know which scope was touched; refresh both.
    await get().loadPersonal()
    const teamId = get().teamNodes[0]?.teamId ?? null
    if (teamId) await get().loadTeamForCurrentTeam(teamId)
  },

  loadTeamRoles: async (teamId) => {
    const [roles, bindings] = await Promise.all([
      selectTeamRoles(teamId),
      selectShortcutRoleBindings(teamId),
    ])
    set({ teamRoles: roles, shortcutVisibility: bindings })
  },

  setVisibleRoles: async (shortcutId, roleIds) => {
    await rpcShortcutSetVisibleRoles(shortcutId, roleIds)
    const teamId = get().teamNodes.find(n => n.id === shortcutId)?.teamId ?? null
    if (teamId) await get().loadTeamRoles(teamId)
  },

  getTree: () => {
    const personal = buildTree(get().personalNodes, null)
    const team     = buildTree(get().teamNodes, null)
    return [...personal, ...team]
  },

  getChildren: (parentId) => {
    const all = [...get().personalNodes, ...get().teamNodes]
    return all.filter(n => n.parentId === parentId).sort((a, b) => a.order - b.order)
  },
}))
```

- [ ] **Step 4: Run the tests**

```bash
pnpm test:unit -- packages/app/src/stores/__tests__/shortcuts.test.ts
```

Expected: PASS — all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/stores/shortcuts.ts packages/app/src/stores/__tests__/shortcuts.test.ts
git commit -m "feat(shortcuts): rewrite store over supabase-js with Tauri-file cache"
```

---

### Task 9: Drop `setCurrentShortcutRoles` glue from `team-members.ts`

**Files:**
- Modify: `packages/app/src/stores/team-members.ts`
- Delete: `packages/app/src/stores/__tests__/team-members-shortcuts-role.test.ts`

- [ ] **Step 1: Open the file and locate the four lines**

```bash
grep -n 'setCurrentShortcutRoles\|normalizeShortcutRoles' packages/app/src/stores/team-members.ts
```

Expected output:
```
44:function normalizeShortcutRoles(roles: string[] | null | undefined): string[] {
53:  useShortcutsStore.getState().setCurrentShortcutRoles(
79:      useShortcutsStore.getState().setCurrentShortcutRoles([])
91:      useShortcutsStore.getState().setCurrentShortcutRoles([])
168:    useShortcutsStore.getState().setCurrentShortcutRoles([])
```

- [ ] **Step 2: Remove `normalizeShortcutRoles` function and all four call sites**

In `packages/app/src/stores/team-members.ts`:

Delete the entire `normalizeShortcutRoles` function (lines 44-48 in the current file).

Delete the call site at line 53 area:
```typescript
useShortcutsStore.getState().setCurrentShortcutRoles(
  normalizeShortcutRoles(/* whatever */)
)
```

Replace lines 79, 91, 168 (each is a standalone `useShortcutsStore.getState().setCurrentShortcutRoles([])`) with nothing (delete the line).

If the `useShortcutsStore` import becomes unused, delete it.

- [ ] **Step 3: Delete the obsolete test**

```bash
rm packages/app/src/stores/__tests__/team-members-shortcuts-role.test.ts
```

- [ ] **Step 4: Run the remaining team-members tests**

```bash
pnpm test:unit -- packages/app/src/stores/__tests__/
```

Expected: PASS.

- [ ] **Step 5: Run typecheck**

```bash
pnpm typecheck
```

Expected: no errors (any `currentShortcutRoles` references will surface — they're cleaned in Task 10–13).

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/stores/team-members.ts packages/app/src/stores/__tests__/team-members-shortcuts-role.test.ts
git commit -m "refactor(team-members): drop setCurrentShortcutRoles glue (RBAC moves server-side)"
```

---

### Task 10: Update `useAppInit` to call new loaders

**Files:**
- Modify: `packages/app/src/hooks/useAppInit.ts`

- [ ] **Step 1: Find the existing team-shortcuts load block**

```bash
grep -n 'loadTeamShortcutsFile\|team-shortcuts' packages/app/src/hooks/useAppInit.ts
```

Expected: line ~499 references `import("@/lib/team-shortcuts")`.

- [ ] **Step 2: Replace the block (lines 498-508 area)**

Old:
```typescript
// Load team shortcuts after team config
import("@/lib/team-shortcuts")
  .then(({ loadTeamShortcutsFile }) => {
    return loadTeamShortcutsFile(workspacePath);
  })
  .then((teamShortcuts) => {
    useShortcutsStore.getState().setTeamNodes(teamShortcuts || []);
  })
  .catch((err: unknown) => {
    console.warn("[App] Failed to load team shortcuts (non-critical):", err);
  });
```

New:
```typescript
// Hydrate shortcuts: first paint from local cache, then refresh from Supabase.
void (async () => {
  try {
    const store = useShortcutsStore.getState();
    await store.hydrateFromCache();
    await store.loadPersonal();
    const teamId = useCurrentTeamStore.getState().team?.id ?? null;
    if (teamId) await store.loadTeamForCurrentTeam(teamId);
  } catch (err: unknown) {
    console.warn("[App] Failed to load shortcuts (non-critical):", err);
  }
})();
```

Add `import { useCurrentTeamStore } from "@/stores/current-team"` near the existing imports if not present.

- [ ] **Step 3: Run the hook tests**

```bash
pnpm test:unit -- packages/app/src/hooks/__tests__/useAppInit.test.ts
```

The test mocks `loadTeamShortcutsFile`; update those mocks to mock the store loaders instead. Open `packages/app/src/hooks/__tests__/useAppInit.test.ts` and:

```typescript
// Remove this:
// loadTeamShortcutsFile: mockLoadTeamShortcutsFile,

// Replace any expect on mockLoadTeamShortcutsFile with expects on the store loader.
```

Expected after fix: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/hooks/useAppInit.ts packages/app/src/hooks/__tests__/useAppInit.test.ts
git commit -m "refactor(app-init): hydrate shortcuts from cache + Supabase (drop team-shortcuts file)"
```

---

### Task 11: Update `ShortcutsPanel.tsx`

**Files:**
- Modify: `packages/app/src/components/panel/ShortcutsPanel.tsx`

- [ ] **Step 1: Remove the legacy import and its callers**

```bash
grep -n 'loadTeamShortcutsFile\|setTeamNodes\|currentShortcutRoles' packages/app/src/components/panel/ShortcutsPanel.tsx
```

Expected matches around lines 27, 167, 219, 221.

- [ ] **Step 2: Apply edits**

Remove:
```typescript
import { loadTeamShortcutsFile } from "@/lib/team-shortcuts"
```

Remove `setTeamNodes` from the destructure on line 167:
```typescript
// before
const { getPersonalTree, getTeamTree, setTeamNodes } = useShortcutsStore()
// after
const { getPersonalTree, getTeamTree, loadTeamForCurrentTeam } = useShortcutsStore()
```

Replace the refresh handler (lines ~219-221):
```typescript
// before
const nodes = await loadTeamShortcutsFile(workspacePath)
if (nodes) {
  setTeamNodes(nodes)
}
// after
const teamId = useCurrentTeamStore.getState().team?.id ?? null
if (teamId) await loadTeamForCurrentTeam(teamId)
```

Add `import { useCurrentTeamStore } from "@/stores/current-team"` near the existing imports if not present.

- [ ] **Step 3: Type-check**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 4: Run any component tests**

```bash
pnpm test:unit -- packages/app/src/components/panel/
```

Expected: PASS (if no panel-specific tests exist, this is a no-op).

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/panel/ShortcutsPanel.tsx
git commit -m "refactor(shortcuts-panel): refresh via Supabase store loader (drop file path)"
```

---

### Task 12: Update `ShortcutsListColumn.tsx`

**Files:**
- Modify: `packages/app/src/components/sidebar/ShortcutsListColumn.tsx`

- [ ] **Step 1: Remove the legacy import and call**

```bash
grep -n 'loadTeamShortcutsFile\|setTeamNodes' packages/app/src/components/sidebar/ShortcutsListColumn.tsx
```

Expected matches around lines 18, 131, 175-176.

- [ ] **Step 2: Apply edits**

Remove:
```typescript
import { loadTeamShortcutsFile } from '@/lib/team-shortcuts'
```

Replace the selector and refresh handler:

```typescript
// before
const setTeamNodes = useShortcutsStore((s) => s.setTeamNodes)
// after
const loadTeamForCurrentTeam = useShortcutsStore((s) => s.loadTeamForCurrentTeam)
```

```typescript
// before
const nodes = await loadTeamShortcutsFile(workspacePath)
if (nodes) setTeamNodes(nodes)
// after
const teamId = useCurrentTeamStore.getState().team?.id ?? null
if (teamId) await loadTeamForCurrentTeam(teamId)
```

Add `import { useCurrentTeamStore } from '@/stores/current-team'` to the imports if not present.

- [ ] **Step 3: Run the sidebar tests**

```bash
pnpm test:unit -- packages/app/src/components/sidebar/__tests__/
```

`SidebarSecondColumn.test.tsx` mocks `loadTeamShortcutsFile`. Remove that mock entry (line 35) and replace any `currentShortcutRoles: []` initial state (line 52) with the new shape (`personalNodes`, `teamNodes`).

Expected after edits: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/components/sidebar/ShortcutsListColumn.tsx packages/app/src/components/sidebar/__tests__/SidebarSecondColumn.test.tsx
git commit -m "refactor(sidebar): shortcuts column uses Supabase store loader"
```

---

### Task 13: Update `ChatPanel.tsx`

**Files:**
- Modify: `packages/app/src/components/chat/ChatPanel.tsx`

- [ ] **Step 1: Locate the legacy block**

```bash
grep -n 'loadTeamShortcutsFile\|setTeamNodes' packages/app/src/components/chat/ChatPanel.tsx
```

Expected matches around lines 536-538.

- [ ] **Step 2: Apply edit**

Replace:
```typescript
const { loadTeamShortcutsFile } = await import('@/lib/team-shortcuts');
const nodes = await loadTeamShortcutsFile(workspacePath);
useShortcutsStore.getState().setTeamNodes(nodes || []);
```

With:
```typescript
const teamId = useCurrentTeamStore.getState().team?.id ?? null;
if (teamId) await useShortcutsStore.getState().loadTeamForCurrentTeam(teamId);
```

Add `import { useCurrentTeamStore } from "@/stores/current-team"` to the imports if not present.

- [ ] **Step 3: Type-check**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/components/chat/ChatPanel.tsx
git commit -m "refactor(chat-panel): shortcuts refresh via Supabase store loader"
```

---

### Task 14: Delete legacy files

**Files:**
- Delete: `packages/app/src/lib/team-shortcuts.ts`
- Delete: `packages/app/src/lib/__tests__/team-shortcuts.test.ts`

- [ ] **Step 1: Verify no remaining importers**

```bash
grep -rn 'team-shortcuts' packages/app apps tests
```

Expected: no matches (Tasks 10-13 cleared them).

- [ ] **Step 2: Delete**

```bash
rm packages/app/src/lib/team-shortcuts.ts packages/app/src/lib/__tests__/team-shortcuts.test.ts
```

- [ ] **Step 3: Full test + typecheck pass**

```bash
pnpm typecheck && pnpm test:unit
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add -u packages/app/src/lib/team-shortcuts.ts packages/app/src/lib/__tests__/team-shortcuts.test.ts
git commit -m "chore: delete dead team-shortcuts file sync layer"
```

---

### Task 15: Rewrite E2E `shortcuts-drag.test.ts`

**Files:**
- Modify: `tests/functional/shortcuts-drag.test.ts`

The original test seeds `_meta/shortcuts.json` and asserts that drag/drop updates the file. The new test seeds shortcuts via the `shortcut_create` RPC against the local Supabase, and asserts that drag/drop calls `shortcut_batch_move` (or that re-fetch returns the new order).

- [ ] **Step 1: Read the existing test file end-to-end**

```bash
cat tests/functional/shortcuts-drag.test.ts
```

Note: this is a tauri-mcp E2E. Each call drives the running desktop app.

- [ ] **Step 2: Replace the seeding section**

Remove any code that writes to `_meta/shortcuts.json`.

Add a seed step that uses a Supabase service-role client (the testing harness exposes one — check `tests/e2e/_helpers/` if uncertain) to insert rows:

```typescript
import { createClient } from '@supabase/supabase-js'

const supa = createClient(
  process.env.VITE_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

// Seed two personal shortcuts and one folder, owned by the test member.
const memberId = await getTestMemberId()  // existing helper in tests/e2e
await supa.from('shortcuts').insert([
  { scope: 'personal', owner_member_id: memberId, label: 'Folder', node_type: 'folder', order: 0 },
  { scope: 'personal', owner_member_id: memberId, label: 'A',      node_type: 'link',   order: 0, target: 'a' },
  { scope: 'personal', owner_member_id: memberId, label: 'B',      node_type: 'link',   order: 1, target: 'b' },
])
```

- [ ] **Step 3: Replace the assertion**

Old: read `_meta/shortcuts.json` and assert new order.

New: after the drag/drop interaction, re-query Supabase and assert order:

```typescript
const { data } = await supa.from('shortcuts')
  .select('label, order')
  .eq('owner_member_id', memberId)
  .order('order', { ascending: true })

expect(data?.map(r => r.label)).toEqual(['B', 'A', 'Folder'])  // or whatever the test moved
```

- [ ] **Step 4: Run the E2E**

```bash
pnpm test:e2e -- shortcuts-drag
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/functional/shortcuts-drag.test.ts
git commit -m "test(e2e): drag/drop asserts via Supabase instead of file"
```

---

## Final Verification

- [ ] **Step 1: Full pgTAP suite**

```bash
supabase test db --local
```

Expected: all tests pass, including the new `015_rbac_shortcuts.sql`.

- [ ] **Step 2: Full front-end suite**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
```

Expected: clean.

- [ ] **Step 3: Manual smoke**

Launch the app (`pnpm tauri:dev`):
1. Sign in as a regular team member. Open the shortcuts panel. Empty list (no migration, expected). Add a personal shortcut. Reload — it's still there.
2. Sign in as a team admin in another seat. Add a team shortcut. As the regular member, refresh the panel — the new team shortcut appears.
3. As admin, create a custom team role `sales`, assign it to one member, bind a team shortcut to require `sales`. The non-`sales` member no longer sees that shortcut after refresh.
4. Kill network. Reload — cached shortcuts still render. Click "add" — error toast surfaces, list unchanged. Restore network — add succeeds.

- [ ] **Step 4: Push branch and open PR**

```bash
git push -u origin <branch>
gh pr create --fill
```

---

## Out-of-scope (tracked for follow-up)

1. **MCP server shortcut access path** — `_meta/shortcuts.json` is no longer authoritative; the MCP integration that read it will return stale/empty data until it's switched to Supabase or deprecated. Separate plan.
2. **Admin UI for managing custom team roles** — the RBAC tables and `team_member_set_roles` RPC are in place, but a settings page to CRUD `team_roles` and assign them to members is its own design. This plan ships only the shortcut-side consumer surface.
3. **Tightening `team_member_roles.SELECT` visibility** — currently open to all team members; if privacy requirements surface, restrict to self + admin/owner.
