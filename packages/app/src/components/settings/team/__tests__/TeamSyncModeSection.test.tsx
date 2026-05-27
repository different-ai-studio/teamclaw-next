import * as React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const mockInvoke = vi.hoisted(() => vi.fn())
const mockTeam = vi.hoisted(() => ({ id: 'team-123', name: 'Test Team', slug: 'test-team' } as { id: string; name: string; slug: string } | null))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (sel: (s: { team: typeof mockTeam }) => unknown) =>
    sel({ team: mockTeam }),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (sel: (s: { workspacePath: string }) => unknown) =>
    sel({ workspacePath: '/workspace' }),
}))

// ---------------------------------------------------------------------------
// Component under test
// ---------------------------------------------------------------------------
import { TeamSyncModeSection } from '../TeamSyncModeSection'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('TeamSyncModeSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    // Reset team to a valid team for each test
    Object.assign(mockTeam, { id: 'team-123', name: 'Test Team', slug: 'test-team' })
  })

  it('loads and displays the current sync mode', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'oss_sync_get_team_sync_mode') return Promise.resolve('git')
      return Promise.resolve(null)
    })

    render(<TeamSyncModeSection />)

    // Shows "loading…" initially
    expect(screen.getByText(/loading/i)).toBeTruthy()

    // After resolve, shows current mode
    await waitFor(() => {
      expect(screen.getByText(/git/i)).toBeTruthy()
    })
    expect(mockInvoke).toHaveBeenCalledWith('oss_sync_get_team_sync_mode', {
      workspacePath: '/workspace',
      teamId: 'team-123',
    })
  })

  it('disables the active-mode button and enables the other', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'oss_sync_get_team_sync_mode') return Promise.resolve('git')
      return Promise.resolve(null)
    })

    render(<TeamSyncModeSection />)

    await waitFor(() => {
      const gitBtn = screen.getByRole('button', { name: /git/i })
      const ossBtn = screen.getByRole('button', { name: /oss/i })
      expect((gitBtn as HTMLButtonElement).disabled).toBe(true)
      expect((ossBtn as HTMLButtonElement).disabled).toBe(false)
    })
  })

  it('switches mode on button click after confirmation', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'oss_sync_get_team_sync_mode') return Promise.resolve('git')
      if (cmd === 'oss_sync_set_team_sync_mode') return Promise.resolve('oss')
      return Promise.resolve(null)
    })

    render(<TeamSyncModeSection />)

    await waitFor(() => screen.getByRole('button', { name: /oss/i }))

    fireEvent.click(screen.getByRole('button', { name: /oss/i }))

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('oss_sync_set_team_sync_mode', {
        workspacePath: '/workspace',
        teamId: 'team-123',
        mode: 'oss',
      })
    })

    // Mode now shows oss — OSS button should be disabled
    await waitFor(() => {
      const ossBtn = screen.getByRole('button', { name: /oss/i })
      expect((ossBtn as HTMLButtonElement).disabled).toBe(true)
    })
  })

  it('shows error message when switch fails', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'oss_sync_get_team_sync_mode') return Promise.resolve('git')
      if (cmd === 'oss_sync_set_team_sync_mode')
        return Promise.reject(new Error('only team owners may switch sync_mode'))
      return Promise.resolve(null)
    })

    render(<TeamSyncModeSection />)

    await waitFor(() => screen.getByRole('button', { name: /oss/i }))
    fireEvent.click(screen.getByRole('button', { name: /oss/i }))

    await waitFor(() => {
      expect(screen.getByText(/only team owners may switch sync_mode/i)).toBeTruthy()
    })
  })

  it('disables buttons while switching is in progress', async () => {
    let resolveSwitch!: (v: string) => void
    const switchPromise = new Promise<string>((res) => {
      resolveSwitch = res
    })

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'oss_sync_get_team_sync_mode') return Promise.resolve('git')
      if (cmd === 'oss_sync_set_team_sync_mode') return switchPromise
      return Promise.resolve(null)
    })

    render(<TeamSyncModeSection />)

    await waitFor(() => screen.getByRole('button', { name: /oss/i }))
    fireEvent.click(screen.getByRole('button', { name: /oss/i }))

    // While awaiting the switch, both buttons should be disabled
    await waitFor(() => {
      const ossBtn = screen.getByRole('button', { name: /oss/i })
      const gitBtn = screen.getByRole('button', { name: /git/i })
      expect((ossBtn as HTMLButtonElement).disabled).toBe(true)
      expect((gitBtn as HTMLButtonElement).disabled).toBe(true)
    })

    // Clean up
    resolveSwitch('oss')
  })
})
