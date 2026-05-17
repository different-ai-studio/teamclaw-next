# Shortcuts → Supabase Migration Design

**Date**: 2026-05-17
**Status**: Spec
**Scope**: Personal + team shortcuts move from local files / OSS / P2P sync to Supabase, with a new generic RBAC layer (`team_roles`, `team_member_roles`, `permissions`, `permission_roles`) that shortcuts will be the first consumer of.

---

## Goals

1. Personal shortcuts sync across a user's devices (desktop / iOS).
2. Team shortcut updates propagate as soon as members open the panel (no OSS/P2P sync cycle wait).
3. One storage layer instead of localStorage + Tauri file + OSS/P2P + JSON file.
4. Replace the ad-hoc `ShortcutNode.role: string[]` ACL with a reusable RBAC framework that channels / agents / files can adopt later.

## Non-goals

- Offline writes. Editing requires network; reads use a local cache.
- Realtime push (Supabase Realtime). Pull on app launch and on panel open is sufficient.
- Migration of existing personal localStorage / `_meta/shortcuts.json` data. Empty start.
- Role hierarchy (`parent_role_id`), role expiry (`expires_at`), primary-role flag. Deferred.
- MCP server's read path for shortcuts (currently reads `_meta/shortcuts.json`). Tracked as follow-up risk, not in this design.

## Decisions

- **Scope of migration**: personal + team.
- **Offline**: read-only via local cache; writes require network.
- **Team edit rights**: only `team_members.role in ('owner','admin')`.
- **Refresh model**: pull on app launch + on panel open (no Realtime subscription).
- **Permission model**: generic — `permissions` middle table so future resources can reuse the same RBAC.
- **No old-data migration**. After release, users see an empty list and re-add as needed. Legacy file paths are deleted, not preserved behind a compatibility flag.

---

## §1 Database schema

New table `public.shortcuts` plus four RBAC tables. The pre-existing `team_members.role ∈ {owner, admin, member}` continues to govern who can edit team data; the new `team_roles` provides custom "tag" roles used for visibility scoping.

```sql
-- Custom team-scoped roles (e.g. "sales", "ops"). Distinct from team_members.role.
create table public.team_roles (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  code text not null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, code)
);

-- Member × custom role.
create table public.team_member_roles (
  id uuid primary key default gen_random_uuid(),
  team_id   uuid not null references public.teams(id)        on delete cascade,
  member_id uuid not null references public.members(id)      on delete cascade,
  role_id   uuid not null references public.team_roles(id)   on delete cascade,
  created_at timestamptz not null default now(),
  unique (team_id, member_id, role_id)
);

-- Registry of protected resources (shortcuts are the first user).
create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  resource_type text not null,         -- 'shortcut' | 'channel' | 'agent' | ...
  resource_id   uuid not null,
  code text not null,                  -- e.g. 'shortcut:<uuid>' for human reads
  created_at timestamptz not null default now(),
  unique (team_id, resource_type, resource_id),
  unique (team_id, code)
);

-- Permission × role (which custom roles can access this resource).
create table public.permission_roles (
  id uuid primary key default gen_random_uuid(),
  permission_id uuid not null references public.permissions(id) on delete cascade,
  role_id       uuid not null references public.team_roles(id)  on delete cascade,
  created_at timestamptz not null default now(),
  unique (permission_id, role_id)
);

-- Shortcut tree. Personal rows attach to a member; team rows attach to a team.
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

create index shortcuts_personal_idx       on public.shortcuts (owner_member_id) where scope = 'personal';
create index shortcuts_team_idx           on public.shortcuts (team_id)         where scope = 'team';
create index shortcuts_parent_idx         on public.shortcuts (parent_id);
create index permissions_resource_idx     on public.permissions (team_id, resource_type, resource_id);
create index permission_roles_role_idx    on public.permission_roles (role_id);
create index team_member_roles_member_idx on public.team_member_roles (team_id, member_id);
```

**Visibility default**: if a team-scope shortcut's `permissions` row has zero `permission_roles` bindings, it is visible to every team member ("open default"). Once at least one binding exists, only members holding one of the bound roles can see it.

**Removed from previous model**: the inline `role text[]` on shortcuts is gone. Visibility lives entirely in `permissions` + `permission_roles`.

---

## §2 RLS

Helpers (SECURITY DEFINER to avoid RLS recursion; pattern matches existing `app.is_session_participant` etc.):

```sql
create or replace function app.is_team_admin_or_owner(target_team_id uuid)
returns boolean language sql stable security definer set search_path = public, app as $$
  select app.current_team_role(target_team_id) in ('owner','admin')
$$;

-- Open default: no bindings → visible to all team members.
-- Otherwise: current member must hold at least one bound role.
create or replace function app.member_can_access_permission(target_permission_id uuid)
returns boolean language sql stable security definer set search_path = public, app as $$
  select case
    when not exists (select 1 from public.permission_roles where permission_id = target_permission_id)
      then true
    else exists (
      select 1
      from public.permission_roles pr
      join public.team_member_roles tmr on tmr.role_id = pr.role_id
      where pr.permission_id = target_permission_id
        and tmr.member_id = app.current_member_id()
    )
  end
$$;

create or replace function app.member_can_see_shortcut(target_shortcut_id uuid)
returns boolean language sql stable security definer set search_path = public, app as $$
  with sc as (select scope, owner_member_id, team_id from public.shortcuts where id = target_shortcut_id)
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
```

Policy matrix:

| Table | SELECT | INSERT / UPDATE / DELETE |
|---|---|---|
| `team_roles`         | `app.is_team_member(team_id)` | `app.is_team_admin_or_owner(team_id)` |
| `team_member_roles`  | `app.is_team_member(team_id)` | `app.is_team_admin_or_owner(team_id)` |
| `permissions`        | `app.is_team_member(team_id)` | `app.is_team_admin_or_owner(team_id)` |
| `permission_roles`   | team_id reached via `permissions`, then `is_team_member` | likewise, then `is_team_admin_or_owner` |
| `shortcuts` personal | `owner_member_id = app.current_member_id()` | `owner_member_id = app.current_member_id()` |
| `shortcuts` team     | `app.member_can_see_shortcut(id)` | `app.is_team_admin_or_owner(team_id)` |

Notes:
- `team_member_roles.SELECT` is granted to all team members (open visibility of who holds which role). Decision recorded; can be tightened to "self + admin/owner" later if privacy needs change.
- There is no automatic trigger that creates a `permissions` row when a team shortcut is inserted; the `shortcut_create` RPC owns that step (see §3).

---

## §3 Write RPCs and triggers

Principle: only use RPCs where cross-table atomicity or multi-step swap-in is needed. Simple CRUD goes through direct table writes guarded by RLS.

```sql
-- 1) Create a shortcut; team scope also inserts the permissions row.
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
language plpgsql security definer set search_path = public, app as $$
declare v_id uuid; v_member uuid := app.current_member_id();
begin
  if v_member is null then raise exception 'not authenticated'; end if;
  if p_scope = 'personal' then
    insert into public.shortcuts (scope, owner_member_id, parent_id, label, icon, "order", node_type, target)
    values ('personal', v_member, p_parent_id, p_label, p_icon, p_order, p_node_type, p_target)
    returning id into v_id;
  elsif p_scope = 'team' then
    if not app.is_team_admin_or_owner(p_team_id) then raise exception 'forbidden'; end if;
    insert into public.shortcuts (scope, team_id, parent_id, label, icon, "order", node_type, target)
    values ('team', p_team_id, p_parent_id, p_label, p_icon, p_order, p_node_type, p_target)
    returning id into v_id;
    insert into public.permissions (team_id, resource_type, resource_id, code)
    values (p_team_id, 'shortcut', v_id, 'shortcut:' || v_id::text);
  else raise exception 'invalid scope: %', p_scope;
  end if;
  return v_id;
end $$;

-- 2) Drag/drop batch reorder; ensures all rows update in one tx.
create or replace function public.shortcut_batch_move(
  p_moves jsonb   -- [{id, parent_id, order}, ...]
) returns int
language plpgsql security definer set search_path = public, app as $$
declare v_count int;
begin
  update public.shortcuts s set
    parent_id  = (m->>'parent_id')::uuid,
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

-- 3) Swap-in: set the full set of roles that can see a shortcut.
create or replace function public.shortcut_set_visible_roles(
  p_shortcut_id uuid,
  p_role_ids uuid[]
) returns void
language plpgsql security definer set search_path = public, app as $$
declare v_team uuid; v_perm uuid;
begin
  select team_id into v_team from public.shortcuts
    where id = p_shortcut_id and scope = 'team';
  if v_team is null then raise exception 'shortcut not found or not team-scoped'; end if;
  if not app.is_team_admin_or_owner(v_team) then raise exception 'forbidden'; end if;
  select id into v_perm from public.permissions
    where team_id = v_team and resource_type = 'shortcut' and resource_id = p_shortcut_id;
  delete from public.permission_roles where permission_id = v_perm;
  insert into public.permission_roles (permission_id, role_id)
    select v_perm, unnest(p_role_ids);
end $$;

-- 4) Swap-in: set the full set of custom roles a member holds.
create or replace function public.team_member_set_roles(
  p_team_id uuid,
  p_member_id uuid,
  p_role_ids uuid[]
) returns void
language plpgsql security definer set search_path = public, app as $$
begin
  if not app.is_team_admin_or_owner(p_team_id) then raise exception 'forbidden'; end if;
  delete from public.team_member_roles
    where team_id = p_team_id and member_id = p_member_id;
  insert into public.team_member_roles (team_id, member_id, role_id)
    select p_team_id, p_member_id, unnest(p_role_ids);
end $$;
```

Trigger to keep `permissions` consistent when a team shortcut is deleted (no FK in that direction):

```sql
create or replace function app.cleanup_shortcut_permission() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if old.scope = 'team' then
    delete from public.permissions
      where team_id = old.team_id and resource_type = 'shortcut' and resource_id = old.id;
  end if;
  return old;
end $$;

create trigger shortcuts_cleanup_permission_after_delete
  after delete on public.shortcuts
  for each row execute function app.cleanup_shortcut_permission();
```

Operations that stay as direct table writes (RLS already enforces auth):

| Operation | Table | Notes |
|---|---|---|
| Update label / icon / target / order | `shortcuts` UPDATE | Single-row edit |
| Delete shortcut (incl. subtree) | `shortcuts` DELETE | `parent_id` cascade clears children; trigger above clears the permissions row |
| Create / delete custom team role | `team_roles` INSERT/DELETE | RLS = admin/owner |
| Single role binding add/remove | `permission_roles` / `team_member_roles` INSERT/DELETE | UI typically uses the swap-in RPC instead |
| All reads | All tables SELECT | RLS handles filtering |

---

## §4 Front-end (`useShortcutsStore`)

Changes:

1. Supabase becomes the sole source of truth. localStorage persistence is removed.
2. The Tauri `save_shortcuts` / `load_shortcuts` calls remain — they now persist a **read-only cache** of the last-fetched tree, used to render UI before the network call completes.
3. All mutators become `async` and call `supabase-js`. Failures throw; the store does not update.
4. The `ShortcutNode.role` field is removed. Role bindings are loaded separately for the admin UI.
5. IDs become UUIDs returned by Supabase.

New `ShortcutsState` shape (key fields):

```ts
interface ShortcutsState {
  personalNodes: ShortcutNode[]     // already RLS-filtered to the current member
  teamNodes:     ShortcutNode[]     // already RLS-filtered for visibility

  loading: boolean
  loadedAt: number | null

  addNode:     (scope: 'personal' | 'team', partial: NewShortcutInput) => Promise<string>
  updateNode:  (id: string, updates: Partial<ShortcutNode>) => Promise<void>
  deleteNode:  (id: string) => Promise<void>
  batchMove:   (moves: Array<{ id: string; parentId: string | null; order: number }>) => Promise<void>

  loadPersonal:            () => Promise<void>
  loadTeamForCurrentTeam:  () => Promise<void>

  // Admin-only, lazy-loaded when opening the editing UI
  teamRoles: TeamRole[] | null
  shortcutVisibility: Map<string, string[]> | null
  loadTeamRoles:   () => Promise<void>
  setVisibleRoles: (shortcutId: string, roleIds: string[]) => Promise<void>
}
```

Write example (add):

```ts
async addNode(scope, partial) {
  const { data, error } = await supabase.rpc('shortcut_create', {
    p_scope:     scope,
    p_team_id:   scope === 'team' ? currentTeamId() : null,
    p_label:     partial.label,
    p_node_type: partial.type,
    p_parent_id: partial.parentId,
    p_icon:      partial.icon,
    p_order:     partial.order ?? 0,
    p_target:    partial.target ?? '',
  })
  if (error) throw error
  if (scope === 'personal') await get().loadPersonal()
  else                       await get().loadTeamForCurrentTeam()
  return data as string
}
```

Read example: `supabase.from('shortcuts').select('*').eq('scope', 'personal')` — RLS filters. No client-side `filterTeamTreeForRoles`, no `currentShortcutRoles` state.

Cache + offline:
- After a successful load, write the tree to the workspace file via existing `save_shortcuts`. File schema gets a `version: 2` bump and stores UUID IDs.
- On launch: call `load_shortcuts` to paint instantly, then kick off Supabase fetch in the background and replace.
- If the network fetch fails, show a subtle "showing cached data" status indicator.
- If there is no cache and the network call fails, show an empty state with a Retry button.

Writes have no offline path: they throw a network error and surface as a toast.

Code to remove (no compatibility shim):
- `packages/app/src/lib/team-shortcuts.ts`
- `packages/app/src/lib/__tests__/team-shortcuts.test.ts`
- `currentShortcutRoles`, `setCurrentShortcutRoles`, `filterTeamTreeForRoles` in `stores/shortcuts.ts`
- The `setCurrentShortcutRoles` wiring in `stores/team-members.ts` (lines 53, 79, 91, 168 today)
- All `loadTeamShortcutsFile` callers in `ShortcutsPanel`, `ShortcutsListColumn`, `ChatPanel`, `useAppInit`

Risks tracked, not addressed here:
- The MCP server (`apps/desktop/binaries/teamclaw-introspect` and friends) currently reads `_meta/shortcuts.json`. After this lands, that path returns stale or empty data. Follow-up work: switch the MCP server's shortcut accessor to Supabase or remove the capability if unused.
- Existing user data is **not** migrated. Users will see an empty shortcuts list after upgrading and re-add the entries they want.

---

## §5 Error handling

| Source | Trigger | UI |
|---|---|---|
| Offline / network drop | supabase-js throws network error | Toast: "需要联网才能编辑快捷方式"; store unchanged |
| Not authenticated / expired token | RPC raises `not authenticated` | Redirect to login; store unchanged |
| Non-admin edits team shortcut | RPC raises `forbidden` | Toast: "只有团队管理员可以编辑" (defensive; UI button should be disabled already) |
| Unique-violation on `permissions(team_id, resource_type, resource_id)` | Should not happen | Sentry + generic "unknown error" toast |
| RLS denial | SELECT returns empty, writes return `42501` | Silent on read; toast on write |

Shared helper `runShortcutRpc(name, args)` in `lib/supabase-client.ts` centralises try/catch, Sentry reporting, and error-code → toast mapping.

Read failures:
- Launch fetch fails → render cache + status bar "showing cached data".
- No cache and fetch fails → empty state with Retry button.

Optimistic updates: **not used**. Writes call the RPC, then re-fetch the affected scope. Shortcut operations are low frequency, and this keeps client state aligned with RLS without local divergence.

---

## §6 Testing

| Layer | What | Tool |
|---|---|---|
| DB schema | XOR constraint, cascade chain, shortcut-delete trigger clears permissions | pgTAP (`services/supabase/tests/`) |
| RLS | Personal isolation across users; team visibility (no binding = all, binding = role-holder only); admin/owner write vs member read-only | pgTAP with multi-user fixtures |
| RPC | `shortcut_create` personal vs team branches; `shortcut_batch_move` atomicity; `shortcut_set_visible_roles` swap-in; `team_member_set_roles` swap-in | pgTAP |
| Front-end store | Mocked supabase-client; re-fetch on add/update/delete; failed write does not update store; cache write happens on successful load | Vitest (replace `stores/__tests__/shortcuts.test.ts` end-to-end) |
| Front-end components | `ShortcutsPanel`, `ShortcutsListColumn` render; edit affordances visible only to admin/owner; role selector wiring | Vitest + Testing Library |
| E2E / functional | Launch → cache paint → Supabase replace; admin adds shortcut → member re-launches → sees it | `tests/functional/` (rewrite `shortcuts-drag.test.ts` to not depend on OSS file sync) |

Explicitly **not** tested:
- Offline write / sync-merge after reconnect (no offline-write path).
- Old data migration (no migration).

---

## Open items (not blocking this spec)

- MCP server shortcut access path — separate follow-up.
- Tightening `team_member_roles.SELECT` to "self + admin/owner" if privacy concerns surface later.
- Adding role hierarchy / expiry / primary flag later (`parent_role_id`, `expires_at`, `is_primary`).
