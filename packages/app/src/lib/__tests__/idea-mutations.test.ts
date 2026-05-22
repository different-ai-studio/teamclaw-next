import { describe, it, expect, vi, beforeEach } from 'vitest'
import { updateIdeaStatus, renameIdea } from '../idea-mutations'

const rpcMock = vi.fn()
const singleMock = vi.fn()

vi.mock('@/lib/supabase-client', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => singleMock(),
        }),
      }),
    }),
    rpc: (name: string, args: unknown) => rpcMock(name, args),
  },
}))

beforeEach(() => {
  rpcMock.mockReset()
  singleMock.mockReset()
  rpcMock.mockResolvedValue({ error: null })
})

describe('updateIdeaStatus', () => {
  it('reads the full idea then calls update_idea with new status', async () => {
    singleMock.mockResolvedValue({
      data: { workspace_id: 'ws-1', title: 'T', description: 'D', status: 'open' },
      error: null,
    })

    await updateIdeaStatus('idea-1', 'in_progress')

    expect(rpcMock).toHaveBeenCalledWith('update_idea', {
      p_idea_id: 'idea-1',
      p_workspace_id: 'ws-1',
      p_title: 'T',
      p_description: 'D',
      p_status: 'in_progress',
    })
  })

  it('throws when fetch fails', async () => {
    singleMock.mockResolvedValue({ data: null, error: new Error('not found') })
    await expect(updateIdeaStatus('idea-1', 'done')).rejects.toThrow('not found')
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('throws when rpc errors', async () => {
    singleMock.mockResolvedValue({
      data: { workspace_id: null, title: 'T', description: null, status: null },
      error: null,
    })
    rpcMock.mockResolvedValue({ error: new Error('rpc failed') })
    await expect(updateIdeaStatus('idea-1', 'done')).rejects.toThrow('rpc failed')
  })
})

describe('renameIdea', () => {
  it('trims and writes new title with existing status fallback to open', async () => {
    singleMock.mockResolvedValue({
      data: { workspace_id: 'ws-1', title: 'old', description: 'D', status: null },
      error: null,
    })

    await renameIdea('idea-1', '  new title  ')

    expect(rpcMock).toHaveBeenCalledWith('update_idea', {
      p_idea_id: 'idea-1',
      p_workspace_id: 'ws-1',
      p_title: 'new title',
      p_description: 'D',
      p_status: 'open',
    })
  })

  it('rejects empty / whitespace title', async () => {
    await expect(renameIdea('idea-1', '   ')).rejects.toThrow('title is required')
    expect(singleMock).not.toHaveBeenCalled()
  })
})
