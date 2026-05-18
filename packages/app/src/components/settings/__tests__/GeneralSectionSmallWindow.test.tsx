import * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const mockInvoke = vi.fn()
const mockRefreshFileTree = vi.fn()
const mockSetAdvancedMode = vi.fn()
const mockAddSuggestion = vi.fn()
const mockRemoveSuggestion = vi.fn()
const mockT = (_key: string, fallback?: string) => fallback ?? _key

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
  }),
}))

vi.mock('i18next', () => ({
  default: {
    language: 'en',
    on: vi.fn(),
    off: vi.fn(),
    changeLanguage: vi.fn(),
  },
}))

vi.mock('@/lib/build-config', () => ({
  appShortName: 'teamclaw',
  buildConfig: {
    app: { shortName: 'teamclaw' },
    defaults: { theme: 'system' },
  },
}))

vi.mock('@/lib/locale', () => ({
  getPreferredLanguage: () => 'en',
  persistLanguage: vi.fn(),
}))

vi.mock('@/lib/permission-policy', () => ({
  getPermissionPolicy: () => 'ask',
  setPermissionPolicy: vi.fn(),
}))

vi.mock('@/stores/suggestions', () => ({
  useSuggestionsStore: (selector: (state: unknown) => unknown) =>
    selector({
      customSuggestions: [],
      addSuggestion: mockAddSuggestion,
      removeSuggestion: mockRemoveSuggestion,
    }),
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (state: unknown) => unknown) =>
    selector({
      advancedMode: false,
      setAdvancedMode: mockSetAdvancedMode,
    }),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) =>
    selector({
      workspacePath: '/tmp/teamclaw-workspace',
      refreshFileTree: mockRefreshFileTree,
    }),
}))

vi.mock('../shared', () => ({
  SettingCard: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  SectionHeader: ({ title }: { title: string }) => <h2>{title}</h2>,
  ToggleSwitch: ({
    enabled,
    onChange,
    disabled,
  }: {
    enabled: boolean
    onChange: (enabled: boolean) => void
    disabled?: boolean
  }) => (
    <button type="button" disabled={disabled} onClick={() => onChange(!enabled)}>
      {enabled ? 'on' : 'off'}
    </button>
  ),
}))

describe('GeneralSection small-window setting', () => {
  beforeEach(() => {
    vi.resetModules()
    mockInvoke.mockReset()
    mockInvoke.mockResolvedValue(null)

    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    })
  })

  it('does not render the small-window shortcut setting', async () => {
    const { GeneralSection } = await import('../GeneralSection')

    render(<GeneralSection />)

    expect(screen.queryByText('Small Window Shortcut')).toBeNull()
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})
