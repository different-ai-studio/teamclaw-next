import * as React from 'react'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
}))

vi.mock('@/lib/version', () => ({
  useAppVersion: () => '2.4.1',
}))

vi.mock('@/stores/updater', () => ({
  useUpdaterStore: (selector: (state: unknown) => unknown) =>
    selector({
      update: { state: 'idle' },
      checkForUpdates: vi.fn(),
      restart: vi.fn(),
    }),
}))

vi.mock('@/lib/build-config', () => ({
  TEAMCLAW_DIR: '.teamclaw',
  appShortName: 'teamclaw',
  buildConfig: {
    app: {
      name: 'TeamClaw',
      shortName: 'teamclaw',
    },
    features: {
      channels: true,
    },
  },
  hasAnyChannel: () => true,
}))

vi.mock('../TeamRankingCard', () => ({
  TeamRankingCard: () => null,
}))

vi.mock('@/stores/team-mode', () => ({
  useTeamModeStore: (selector: (state: unknown) => unknown) =>
    selector({
      teamModeType: null,
    }),
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (state: unknown) => unknown) =>
    selector({
      settingsInitialSection: null,
    }),
}))

vi.mock('../section-registry', () => ({
  SettingsSectionBody: ({ section }: { section: string }) => <main data-testid="settings-section">{section}</main>,
}))

describe('Settings navigation', () => {
  it('default (client) entry shows only the Client group — no Daemon/Local Agent', async () => {
    const { Settings } = await import('../Settings')

    render(<Settings />)

    // Client group present, expanded by default to a client section.
    expect(screen.getByRole('button', { name: 'Client' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'General' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Team Shared' })).toBeInTheDocument()
    expect(screen.getByTestId('client-subnav')).toBeInTheDocument()

    // The Daemon + Local Agent settings are a SEPARATE dialog — not shown here.
    expect(screen.queryByRole('button', { name: 'Daemon' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Local Agent' })).toBeNull()
    expect(screen.queryByTestId('local-agent-subnav')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Workspace' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'LLM Model' })).toBeNull()
  })

  it('daemon entry (initial daemon section) shows only the merged Local Agent group', async () => {
    vi.resetModules()
    vi.doMock('@/stores/ui', () => ({
      useUIStore: (selector: (state: unknown) => unknown) =>
        selector({ settingsInitialSection: 'daemonGeneral' }),
    }))
    const { Settings } = await import('../Settings')

    render(<Settings />)

    // The Client group is a separate dialog — not shown here.
    expect(screen.queryByRole('button', { name: 'Client' })).toBeNull()
    expect(screen.queryByTestId('client-subnav')).toBeNull()

    expect(screen.getByRole('button', { name: 'Local Agent' })).toBeInTheDocument()
    const localAgentSubnav = screen.getByTestId('local-agent-subnav')
    // Daemon sections first, then the opencode agent config — all in one group.
    expect(
      within(localAgentSubnav).getAllByRole('button').map((button) => button.textContent)
    ).toEqual([
      'General',
      'Workspace',
      'Runtimes',
      'Automation',
      'Channels',
      'LLM Model',
      'Env Variables',
      'Prompt',
      'MCP',
      'Roles',
      'Role Skills',
      'Skills',
      'Knowledge Base',
      'Dependencies',
    ])
    vi.doUnmock('@/stores/ui')
  })
})
