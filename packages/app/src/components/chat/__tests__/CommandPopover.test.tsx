import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CommandPopover } from '../CommandPopover'

const mocks = vi.hoisted(() => ({
  runtimeRows: [] as Array<{ runtime_id: string | null; backend_type: string | null; current_model: string | null }>,
  runtimeStates: {} as Record<string, unknown>,
  loadAllSkills: vi.fn(),
  loadAllRoles: vi.fn(),
  readSkillPermissions: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, arg1?: string | { count?: number }, arg2?: { count?: number }) => {
      if (typeof arg1 === 'string') return arg1
      const count = typeof arg1 === 'object' ? arg1?.count : arg2?.count
      if (typeof count === 'number') return `${key}:${count}`
      return key
    },
  }),
}))

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>('@/lib/utils')
  return {
    ...actual,
    isTauri: () => true,
  }
})

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: { workspacePath: string | null }) => unknown) =>
    selector({ workspacePath: '/workspace/demo' }),
}))

vi.mock('@/stores/runtime-state-store', () => ({
  useRuntimeStateStore: (selector: (s: { byRuntimeId: Record<string, unknown> }) => unknown) =>
    selector({ byRuntimeId: mocks.runtimeStates }),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    runtime: {
      listSessionRuntimeModels: () => Promise.resolve(mocks.runtimeRows),
    },
  }),
}))

vi.mock('@/lib/git/skill-loader', () => ({
  loadAllSkills: (...args: unknown[]) => mocks.loadAllSkills(...args),
}))

vi.mock('@/lib/roles/loader', () => ({
  loadAllRoles: (...args: unknown[]) => mocks.loadAllRoles(...args),
}))

vi.mock('@/lib/teamclaw-config', () => ({
  readSkillPermissions: (...args: unknown[]) => mocks.readSkillPermissions(...args),
  resolveSkillPermission: () => ({ permission: 'allow', isExact: false }),
}))

describe('CommandPopover', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.runtimeRows = []
    mocks.runtimeStates = {}
    mocks.loadAllSkills.mockResolvedValue({ skills: [], overrides: [] })
    mocks.loadAllRoles.mockResolvedValue([])
    mocks.readSkillPermissions.mockResolvedValue({})
  })

  it('shows daemon-advertised skills for the active session', async () => {
    mocks.runtimeRows = [
      { runtime_id: 'rt-1', backend_type: 'opencode', current_model: null },
    ]
    mocks.runtimeStates = {
      'rt-1': {
        daemonDeviceId: 'agent-1',
        lastUpdated: Date.now(),
        info: {
          availableCommands: [
            {
              name: 'superpowers/brainstorming',
              description: 'Explore intent before coding',
              inputHint: '',
            },
          ],
        },
      },
    }

    render(
      <CommandPopover
        open={true}
        activeSessionId="session-1"
        onOpenChange={vi.fn()}
        searchQuery=""
        onSelect={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('superpowers/brainstorming')).toBeInTheDocument()
    })
  })

  it('selects a daemon-advertised skill using skill token semantics when it matches a known skill', async () => {
    mocks.runtimeRows = [
      { runtime_id: 'rt-1', backend_type: 'opencode', current_model: null },
    ]
    mocks.runtimeStates = {
      'rt-1': {
        daemonDeviceId: 'agent-1',
        lastUpdated: Date.now(),
        info: {
          availableCommands: [
            {
              name: 'superpowers/brainstorming',
              description: 'Explore intent before coding',
              inputHint: '',
            },
          ],
        },
      },
    }
    mocks.loadAllSkills.mockResolvedValue({
      skills: [
        {
          filename: 'brainstorming',
          name: 'Brainstorming',
          invocationName: 'superpowers/brainstorming',
          content: '---\ndescription: Explore intent before coding\n---\n# Brainstorming\n',
          source: 'global-agent',
          dirPath: '/Users/test/.agents/skills/superpowers',
        },
      ],
      overrides: [],
    })

    const onSelect = vi.fn()

    render(
      <CommandPopover
        open={true}
        activeSessionId="session-1"
        onOpenChange={vi.fn()}
        searchQuery=""
        onSelect={onSelect}
      />,
    )

    const item = await screen.findByText('superpowers/brainstorming')
    fireEvent.click(item)

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'superpowers/brainstorming',
        _type: 'skill',
      }),
    )
  })

  it('treats daemon-advertised namespaced skills as skill tokens even when local skill scan is empty', async () => {
    mocks.runtimeRows = [
      { runtime_id: 'rt-1', backend_type: 'opencode', current_model: null },
    ]
    mocks.runtimeStates = {
      'rt-1': {
        daemonDeviceId: 'agent-1',
        lastUpdated: Date.now(),
        info: {
          availableCommands: [
            {
              name: 'superpowers/brainstorming',
              description: 'Explore intent before coding',
              inputHint: '',
            },
          ],
        },
      },
    }

    const onSelect = vi.fn()

    render(
      <CommandPopover
        open={true}
        activeSessionId="session-1"
        onOpenChange={vi.fn()}
        searchQuery=""
        onSelect={onSelect}
      />,
    )

    const item = await screen.findByText('superpowers/brainstorming')
    fireEvent.click(item)

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'superpowers/brainstorming',
        _type: 'skill',
      }),
    )
  })
})
