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
