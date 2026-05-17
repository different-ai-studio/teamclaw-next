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
