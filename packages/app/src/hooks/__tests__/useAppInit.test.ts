import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

// --- Hoist mocks ---
const {
  mockSetWorkspace,
  mockSetWorkspaceBootstrapped,
  mockSetWorkspaceReady,
  mockIsTauri,
  mockExists,
  mockInvoke,
  mockListen,
  mockLoadCurrentNodeId,
  mockLoadMembers,
  mockHydrateFromCache,
  mockLoadPersonal,
  mockLoadTeamForCurrentTeam,
} = vi.hoisted(() => ({
  mockSetWorkspace: vi.fn(),
  mockSetWorkspaceBootstrapped: vi.fn(),
  mockSetWorkspaceReady: vi.fn(),
  mockIsTauri: vi.fn(() => false),
  mockExists: vi.fn(),
  mockInvoke: vi.fn(),
  mockListen: vi.fn(),
  mockLoadCurrentNodeId: vi.fn(),
  mockLoadMembers: vi.fn(),
  mockHydrateFromCache: vi.fn(),
  mockLoadPersonal: vi.fn(),
  mockLoadTeamForCurrentTeam: vi.fn(),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: mockIsTauri,
  openExternalUrl: vi.fn(),
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: mockExists,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: mockListen,
}))

const workspaceState = {
  workspacePath: null as string | null,
  setWorkspace: mockSetWorkspace,
  setWorkspaceBootstrapped: mockSetWorkspaceBootstrapped,
  setWorkspaceReady: mockSetWorkspaceReady,
  workspaceBootstrapped: false,
  workspaceReady: false,
  openPanel: vi.fn(),
  closePanel: vi.fn(),
}

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(workspaceState as unknown as Record<string, unknown>),
}))

const teamModeState = {
  teamModeType: null as string | null,
  setState: vi.fn(),
}

vi.mock('@/stores/team-mode', () => ({
  useTeamModeStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector(teamModeState as unknown as Record<string, unknown>),
    {
      getState: () => teamModeState,
      setState: teamModeState.setState,
    },
  ),
}))

vi.mock('@/stores/channels', () => ({
  useChannelsStore: () => ({
    autoStartEnabledGateways: vi.fn(),
    loadConfig: vi.fn().mockResolvedValue(undefined),
    stopAllAndReset: vi.fn().mockResolvedValue(undefined),
    keepAliveCheck: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('@/stores/git-repos', () => ({
  useGitReposStore: () => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    syncAll: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('@/stores/team-members', () => ({
  useTeamMembersStore: {
    getState: () => ({
      loadCurrentNodeId: mockLoadCurrentNodeId,
      loadMembers: mockLoadMembers,
    }),
  },
}))

vi.mock('@/stores/shortcuts', () => ({
  useShortcutsStore: {
    getState: () => ({
      hydrateFromCache: mockHydrateFromCache,
      loadPersonal: mockLoadPersonal,
      loadTeamForCurrentTeam: mockLoadTeamForCurrentTeam,
    }),
  },
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: {
    getState: () => ({ team: null }),
  },
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      layoutMode: 'task',
      toggleLayoutMode: vi.fn(),
    }),
}))

vi.mock('@/stores/deps', () => ({
  useDepsStore: () => ({
    dependencies: [],
    checked: false,
    checkDependencies: vi.fn().mockResolvedValue([]),
  }),
  getSetupDecision: () => 'skip',
  markSetupCompleted: vi.fn(),
}))

vi.mock('@/stores/telemetry', () => ({
  useTelemetryStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      consent: 'undecided',
      init: vi.fn(),
      isInitialized: false,
    }),
}))



beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  mockIsTauri.mockReturnValue(false)
  mockExists.mockResolvedValue(true)
  mockInvoke.mockResolvedValue(null)
  mockListen.mockResolvedValue(vi.fn())
  mockLoadCurrentNodeId.mockResolvedValue(undefined)
  mockLoadMembers.mockResolvedValue(undefined)
  mockHydrateFromCache.mockResolvedValue(undefined)
  mockLoadPersonal.mockResolvedValue(undefined)
  mockLoadTeamForCurrentTeam.mockResolvedValue(undefined)
  workspaceState.workspacePath = null
  workspaceState.workspaceBootstrapped = false
  workspaceState.workspaceReady = false
  teamModeState.teamModeType = null
  teamModeState.setState.mockClear()
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useWorkspaceInit', () => {
  it('restores the last workspace when one is saved', async () => {
    localStorage.setItem('teamclaw-workspace-path', '/tmp/teamclaw-last')

    const { useWorkspaceInit } = await import('@/hooks/useAppInit')
    const { result } = renderHook(() => useWorkspaceInit())

    await waitFor(() => {
      expect(mockSetWorkspace).toHaveBeenCalledWith('/tmp/teamclaw-last')
      expect(result.current.initialWorkspaceResolved).toBe(true)
    })
  })

  it('clears a saved workspace when it no longer exists in Tauri and leaves the picker to handle it', async () => {
    mockIsTauri.mockReturnValue(true)
    mockExists.mockResolvedValue(false)
    localStorage.setItem('teamclaw-workspace-path', '/tmp/missing-workspace')

    const { useWorkspaceInit } = await import('@/hooks/useAppInit')
    const { result } = renderHook(() => useWorkspaceInit())

    await waitFor(() => {
      expect(localStorage.getItem('teamclaw-workspace-path')).toBeNull()
      expect(result.current.initialWorkspaceResolved).toBe(true)
    })
    // The stale saved path is cleared, but we deliberately do NOT fall back
    // to a default workspace — the user must pick one explicitly so a freshly
    // joined team doesn't silently land in an unrelated directory.
    expect(mockSetWorkspace).not.toHaveBeenCalled()
  })

  it('does not set a default workspace when nothing is saved (picker handles it)', async () => {
    const { useWorkspaceInit } = await import('@/hooks/useAppInit')
    const { result } = renderHook(() => useWorkspaceInit())

    await waitFor(() => {
      expect(result.current.initialWorkspaceResolved).toBe(true)
    })
    expect(mockSetWorkspace).not.toHaveBeenCalled()
  })
})

describe('useTauriBodyClass', () => {
  it('does not add tauri class in non-Tauri environment', async () => {
    const { useTauriBodyClass } = await import('@/hooks/useAppInit')
    renderHook(() => useTauriBodyClass())
    expect(document.documentElement.classList.contains('tauri')).toBe(false)
  })
})

describe('useLayoutModeShortcut', () => {
  it('renders without error', async () => {
    const { useLayoutModeShortcut } = await import('@/hooks/useAppInit')
    const { result } = renderHook(() => useLayoutModeShortcut())
    expect(result.current).toBeUndefined()
  })
})

describe('useSetupGuide', () => {
  it('returns showSetupGuide as false initially', async () => {
    const { useSetupGuide } = await import('@/hooks/useAppInit')
    const { result } = renderHook(() => useSetupGuide(false))
    expect(result.current.showSetupGuide).toBe(false)
    expect(result.current.dependencies).toEqual([])
  })
})

describe('useTelemetryConsent', () => {
  it('returns showConsentDialog as false initially', async () => {
    const { useTelemetryConsent } = await import('@/hooks/useAppInit')
    const { result } = renderHook(() => useTelemetryConsent(false))
    expect(result.current.showConsentDialog).toBe(false)
  })
})

describe('useGitReposInit', () => {
  it('hydrates current member roles when loading team shortcuts on startup', async () => {
    mockIsTauri.mockReturnValue(true)
    workspaceState.workspacePath = '/workspace-team'
    workspaceState.workspaceReady = true

    const { useGitReposInit } = await import('@/hooks/useAppInit')
    renderHook(() => useGitReposInit())

    await waitFor(() => {
      expect(mockLoadCurrentNodeId).toHaveBeenCalled()
      expect(mockLoadMembers).toHaveBeenCalled()
    })
  })

  it('refreshes current member shortcut roles when member manifest files change', async () => {
    mockIsTauri.mockReturnValue(true)
    workspaceState.workspacePath = '/workspace-team'
    workspaceState.workspaceReady = true

    const { useGitReposInit } = await import('@/hooks/useAppInit')
    renderHook(() => useGitReposInit())

    await waitFor(() => {
      expect(mockListen).toHaveBeenCalledWith('file-change', expect.any(Function))
    })

    mockLoadCurrentNodeId.mockClear()
    mockLoadMembers.mockClear()
    vi.useFakeTimers()

    const fileChangeCallback = mockListen.mock.calls.find(
      ([eventName]) => eventName === 'file-change',
    )?.[1] as ((event: { payload: { path: string; kind: string } }) => void) | undefined

    expect(fileChangeCallback).toBeDefined()
    fileChangeCallback?.({
      payload: {
        path: '/workspace-team/teamclaw-team/_meta/members.json',
        kind: 'modify',
      },
    })

    await vi.advanceTimersByTimeAsync(600)

    expect(mockLoadCurrentNodeId).toHaveBeenCalled()
    expect(mockLoadMembers).toHaveBeenCalled()
  })

  it('refreshes current member shortcut roles when team members change', async () => {
    mockIsTauri.mockReturnValue(true)
    workspaceState.workspacePath = '/workspace-team'
    workspaceState.workspaceReady = true

    const { useGitReposInit } = await import('@/hooks/useAppInit')
    renderHook(() => useGitReposInit())

    await waitFor(() => {
      expect(mockListen).toHaveBeenCalledWith('team:members-changed', expect.any(Function))
    })

    mockLoadCurrentNodeId.mockClear()
    mockLoadMembers.mockClear()

    const membersChangedCallback = mockListen.mock.calls.find(
      ([eventName]) => eventName === 'team:members-changed',
    )?.[1] as (() => void) | undefined

    expect(membersChangedCallback).toBeDefined()
    membersChangedCallback?.()

    await waitFor(() => {
      expect(mockLoadCurrentNodeId).toHaveBeenCalled()
      expect(mockLoadMembers).toHaveBeenCalled()
    })
  })
})
