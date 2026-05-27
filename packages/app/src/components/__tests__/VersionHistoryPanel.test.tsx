import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'
import type { VersionInfo } from '@/stores/oss-sync'

// ── Mock store ──────────────────────────────────────────────────────────────

const mockListVersions = vi.fn()
const mockRestoreVersion = vi.fn()

vi.mock('@/stores/oss-sync', () => ({
  useOssSyncStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const state = {
      listVersions: mockListVersions,
      restoreVersion: mockRestoreVersion,
    }
    return selector(state)
  },
}))

// ── Import component after mocks ────────────────────────────────────────────

const { VersionHistoryPanel } = await import(
  '../oss-sync/VersionHistoryPanel'
)

// ── Fixtures ────────────────────────────────────────────────────────────────

const VERSIONS: VersionInfo[] = [
  {
    version: 2,
    contentHash: 'hash-v2',
    size: 512,
    deleted: false,
    createdAt: '2026-05-27T12:00:00Z',
    message: 'second edit',
  },
  {
    version: 1,
    contentHash: 'hash-v1',
    size: 480,
    deleted: false,
    createdAt: '2026-05-26T10:00:00Z',
    message: null,
  },
]

// ── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockListVersions.mockReset()
  mockRestoreVersion.mockReset()
})

describe('VersionHistoryPanel', () => {
  it('renders version list after load', async () => {
    mockListVersions.mockResolvedValueOnce(VERSIONS)

    render(
      <VersionHistoryPanel
        workspacePath="/workspace/path"
        path="notes/foo.md"
      />,
    )

    // Header is rendered immediately.
    expect(screen.getByText(/Versions of/)).toBeTruthy()

    // Version rows appear after the promise resolves.
    await waitFor(() => {
      expect(screen.getByText(/v2/)).toBeTruthy()
      expect(screen.getByText(/v1/)).toBeTruthy()
    })

    expect(mockListVersions).toHaveBeenCalledWith(
      '/workspace/path',
      'notes/foo.md',
    )
  })

  it('calls restoreVersion on Restore button click', async () => {
    mockListVersions.mockResolvedValueOnce(VERSIONS)
    mockRestoreVersion.mockResolvedValueOnce(undefined)

    render(
      <VersionHistoryPanel
        workspacePath="/workspace/path"
        path="notes/foo.md"
      />,
    )

    await waitFor(() => screen.getAllByRole('button', { name: /Restore/i }))

    const buttons = screen.getAllByRole('button', { name: /Restore/i })
    // First button = v2
    fireEvent.click(buttons[0])

    expect(mockRestoreVersion).toHaveBeenCalledWith(
      '/workspace/path',
      'notes/foo.md',
      'hash-v2',
    )
  })

  it('shows error when listVersions rejects', async () => {
    mockListVersions.mockRejectedValueOnce(new Error('fetch failed'))

    render(
      <VersionHistoryPanel
        workspacePath="/workspace/path"
        path="notes/foo.md"
      />,
    )

    await waitFor(() => {
      expect(screen.getByText(/fetch failed/)).toBeTruthy()
    })
  })

  it('disables Restore button for versions without contentHash', async () => {
    const nullHashVersions: VersionInfo[] = [
      {
        version: 1,
        contentHash: null,
        size: 0,
        deleted: true,
        createdAt: '2026-05-26T10:00:00Z',
        message: null,
      },
    ]
    mockListVersions.mockResolvedValueOnce(nullHashVersions)

    render(
      <VersionHistoryPanel
        workspacePath="/workspace/path"
        path="notes/deleted.md"
      />,
    )

    await waitFor(() => screen.getByRole('button', { name: /Restore/i }))

    const button = screen.getByRole('button', { name: /Restore/i })
    expect(button).toBeDisabled()
  })
})
