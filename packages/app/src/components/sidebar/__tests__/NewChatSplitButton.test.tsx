import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NewChatSplitButton } from '../NewChatSplitButton'

const onPrimaryClick = vi.fn()
const openDialog = vi.fn()

vi.mock('@/stores/ui', () => ({
  useUIStore: {
    getState: () => ({ openNewSessionDialog: openDialog }),
  },
}))

describe('NewChatSplitButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('primary click delegates to onPrimaryClick when ready', () => {
    render(
      <NewChatSplitButton
        quickChatState={{ kind: 'ready' }}
        creating={false}
        onPrimaryClick={onPrimaryClick}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /新聊天/i }))
    expect(onPrimaryClick).toHaveBeenCalled()
  })

  it('keeps primary enabled when agent is not bound (redirect handled upstream)', () => {
    render(
      <NewChatSplitButton
        quickChatState={{ kind: 'agent_not_bound' }}
        creating={false}
        onPrimaryClick={onPrimaryClick}
      />,
    )
    const button = screen.getByRole('button', { name: /新聊天/i })
    expect(button).not.toBeDisabled()
    fireEvent.click(button)
    expect(onPrimaryClick).toHaveBeenCalled()
    expect(screen.queryByText(/未检测到本机 amuxd Agent/i)).not.toBeInTheDocument()
  })

  it('disables primary when daemon is down', () => {
    render(
      <NewChatSplitButton
        quickChatState={{ kind: 'daemon_down' }}
        creating={false}
        onPrimaryClick={onPrimaryClick}
      />,
    )
    expect(screen.getByRole('button', { name: /新聊天/i })).toBeDisabled()
  })

  it('expands inline panel below button and opens dialog on group session click', () => {
    render(
      <NewChatSplitButton
        quickChatState={{ kind: 'ready' }}
        creating={false}
        onPrimaryClick={onPrimaryClick}
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
})
