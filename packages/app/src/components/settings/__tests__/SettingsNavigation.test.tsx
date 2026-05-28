import * as React from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
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
  it('nests daemon settings above Local Agent and keeps LLM Model first locally', async () => {
    const { Settings } = await import('../Settings')

    render(<Settings />)

    expect(screen.queryByRole('button', { name: 'Channels' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Automation' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'General' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Team Shared' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Team' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Workspace' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Runtimes' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Env Variables' })).toBeNull()

    const daemonButton = screen.getByRole('button', { name: 'Daemon' })
    const localAgentButton = screen.getByRole('button', { name: 'Local Agent' })
    const topLevelButtons = screen.getAllByRole('button')
    expect(topLevelButtons.indexOf(daemonButton)).toBeLessThan(topLevelButtons.indexOf(localAgentButton))

    fireEvent.click(daemonButton)
    const daemonSubnav = screen.getByTestId('daemon-subnav')
    expect(within(daemonSubnav).getByRole('button', { name: 'General' })).toBeInTheDocument()
    expect(within(daemonSubnav).getByRole('button', { name: 'Workspace' })).toBeInTheDocument()
    expect(within(daemonSubnav).getByRole('button', { name: 'Runtimes' })).toBeInTheDocument()
    expect(within(daemonSubnav).getByRole('button', { name: 'Automation' })).toBeInTheDocument()
    expect(within(daemonSubnav).getByRole('button', { name: 'Channels' })).toBeInTheDocument()
    expect(
      within(daemonSubnav).getAllByRole('button').map((button) => button.textContent)
    ).toEqual([
      'General',
      'Workspace',
      'Runtimes',
      'Automation',
      'Channels',
    ])

    fireEvent.click(localAgentButton)

    const localAgentSubnav = screen.getByTestId('local-agent-subnav')
    expect(within(localAgentSubnav).queryByRole('button', { name: 'Basic Info' })).toBeNull()
    expect(within(localAgentSubnav).getByRole('button', { name: 'LLM Model' })).toBeInTheDocument()
    expect(within(localAgentSubnav).queryByRole('button', { name: 'Automation' })).toBeNull()
    expect(within(localAgentSubnav).getByRole('button', { name: 'Env Variables' })).toBeInTheDocument()
    expect(within(localAgentSubnav).queryByRole('button', { name: 'Channels' })).toBeNull()
    expect(
      within(localAgentSubnav).getAllByRole('button').map((button) => button.textContent)
    ).toEqual([
      'LLM Model',
      'Env Variables',
      'Prompt',
      'Permissions',
      'MCP',
      'Roles',
      'Role Skills',
      'Skills',
      'Knowledge Base',
      'Dependencies',
    ])
  })
})
