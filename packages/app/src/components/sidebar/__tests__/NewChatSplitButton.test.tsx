import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { NewChatSplitButton } from '../NewChatSplitButton'

const createQuick = vi.fn()
const openDialog = vi.fn()

vi.mock('@/lib/quick-daemon-session', () => ({
  createQuickDaemonSession: (...a: unknown[]) => createQuick(...a),
}))
vi.mock('@/stores/ui', () => ({
  useUIStore: {
    getState: () => ({ openNewSessionDialog: openDialog }),
  },
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

describe('NewChatSplitButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createQuick.mockResolvedValue({ sessionId: 's1', agentDisplayName: 'MAC' })
  })

  it('primary click calls createQuickDaemonSession', async () => {
    render(
      <NewChatSplitButton
        hasWorkspace
        localAgentReady
        onOpenAgentSettings={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /新聊天/i }))
    await waitFor(() => expect(createQuick).toHaveBeenCalled())
  })

  it('expands inline panel below button and opens dialog on group session click', () => {
    render(
      <NewChatSplitButton
        hasWorkspace
        localAgentReady
        onOpenAgentSettings={vi.fn()}
      />,
    )
    const wrap = screen.getByTestId('new-chat-more-panel-wrap')
    expect(wrap).toHaveAttribute('aria-hidden', 'true')
    fireEvent.click(screen.getByRole('button', { name: /更多新建选项/i }))
    expect(wrap).toHaveAttribute('aria-hidden', 'false')
    fireEvent.click(screen.getByRole('button', { name: /多人会话/i }))
    expect(openDialog).toHaveBeenCalled()
    expect(wrap).toHaveAttribute('aria-hidden', 'true')
  })

  it('disables primary when local agent not ready', () => {
    render(
      <NewChatSplitButton
        hasWorkspace
        localAgentReady={false}
        onOpenAgentSettings={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /新聊天/i })).toBeDisabled()
  })
})
