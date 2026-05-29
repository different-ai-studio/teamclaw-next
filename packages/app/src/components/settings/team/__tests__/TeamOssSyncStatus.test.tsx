import * as React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const oss = vi.hoisted(() => ({
  lastSyncAt: null as string | null,
  dirtyCount: 0,
  totalFiles: 0,
  recentFiles: [] as Array<{ path: string; syncedVersion: number; dirty: boolean; mtime: number }>,
  syncing: false,
  lastError: null as string | null,
  refresh: vi.fn().mockResolvedValue(undefined),
  syncNow: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fb?: string) => fb ?? _k, i18n: { language: 'en' } }),
}))
vi.mock('@/lib/utils', () => ({ isTauri: () => true, cn: (...a: string[]) => a.join(' ') }))
vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (sel: (s: { team: { id: string } | null }) => unknown) =>
    sel({ team: { id: 'team-1' } }),
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (sel: (s: { workspacePath: string | null }) => unknown) =>
    sel({ workspacePath: '/ws' }),
}))
vi.mock('@/stores/oss-sync', () => ({
  useOssSyncStore: (sel: (s: typeof oss) => unknown) => sel(oss),
}))

import { TeamOssSyncStatus } from '../TeamOssSyncStatus'

beforeEach(() => {
  oss.lastSyncAt = null
  oss.dirtyCount = 0
  oss.totalFiles = 0
  oss.recentFiles = []
  oss.syncing = false
  oss.lastError = null
  oss.refresh = vi.fn().mockResolvedValue(undefined)
  oss.syncNow = vi.fn().mockResolvedValue(undefined)
})

describe('TeamOssSyncStatus', () => {
  it('renders the OSS sync status and refreshes on mount', async () => {
    oss.lastSyncAt = '2026-05-29T06:30:00Z'
    oss.totalFiles = 128
    oss.dirtyCount = 0
    render(<TeamOssSyncStatus />)
    expect(screen.getByText('Synced')).toBeInTheDocument()
    expect(screen.getByText('128')).toBeInTheDocument()
    await waitFor(() => expect(oss.refresh).toHaveBeenCalledWith('/ws'))
  })

  it('shows pending state when there are dirty files', () => {
    oss.dirtyCount = 3
    render(<TeamOssSyncStatus />)
    expect(screen.getByText('Out of sync')).toBeInTheDocument()
  })

  it('triggers a manual sync when "Sync now" is clicked', () => {
    render(<TeamOssSyncStatus />)
    fireEvent.click(screen.getByTestId('oss-sync-now'))
    expect(oss.syncNow).toHaveBeenCalledWith('/ws')
  })

  it('lists recently synced files when present', () => {
    oss.recentFiles = [
      { path: 'knowledge/notes.md', syncedVersion: 3, dirty: false, mtime: 1780000000 },
      { path: 'skills/build.md', syncedVersion: 1, dirty: true, mtime: 1779990000 },
    ]
    render(<TeamOssSyncStatus />)
    expect(screen.getByText('knowledge/notes.md')).toBeInTheDocument()
    expect(screen.getByText('skills/build.md')).toBeInTheDocument()
    expect(screen.getByText('Recently synced files')).toBeInTheDocument()
  })
})
