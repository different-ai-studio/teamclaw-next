import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockInvoke = vi.fn()
const mockListen = vi.fn(() => Promise.resolve(() => {}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
}))

// ── Import store after mocks ──────────────────────────────────────────────

const { useOssSyncStore } = await import('../oss-sync')

// ── Helpers ───────────────────────────────────────────────────────────────

function resetState() {
  useOssSyncStore.setState({
    syncing: false,
    lastSyncAt: null,
    teamId: null,
    fileStatusMap: {},
    conflicts: [],
    lastError: null,
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockInvoke.mockReset()
  mockListen.mockReset()
  mockListen.mockReturnValue(Promise.resolve(() => {}))
  resetState()
})

describe('useOssSyncStore', () => {
  // ── refresh ──────────────────────────────────────────────────────────────

  describe('refresh', () => {
    it('updates teamId and lastSyncAt from oss_sync_status', async () => {
      mockInvoke.mockResolvedValueOnce({
        teamId: 'team-abc',
        lastServerSeq: 5,
        lastSyncAt: '2026-05-27T12:00:00Z',
        dirtyCount: 0,
        totalFiles: 10,
      })

      await useOssSyncStore.getState().refresh('/workspace/path')

      expect(mockInvoke).toHaveBeenCalledWith('oss_sync_status', {
        workspacePath: '/workspace/path',
      })
      const state = useOssSyncStore.getState()
      expect(state.teamId).toBe('team-abc')
      expect(state.lastSyncAt).toBe('2026-05-27T12:00:00Z')
      expect(state.lastError).toBeNull()
    })

    it('sets lastError on failure', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('network error'))

      await useOssSyncStore.getState().refresh('/workspace/path')

      expect(useOssSyncStore.getState().lastError).toMatch('network error')
    })
  })

  // ── syncNow ──────────────────────────────────────────────────────────────

  describe('syncNow', () => {
    it('flips syncing true then false on success', async () => {
      const syncResult = { pulled: 2, pushed: 1, conflicts: 0 }
      const statusResult = {
        teamId: 'team-xyz',
        lastServerSeq: 10,
        lastSyncAt: '2026-05-27T13:00:00Z',
        dirtyCount: 0,
        totalFiles: 5,
      }

      const syncingValues: boolean[] = []
      useOssSyncStore.subscribe((state) => {
        syncingValues.push(state.syncing)
      })

      mockInvoke
        .mockResolvedValueOnce(syncResult) // oss_sync_now
        .mockResolvedValueOnce(statusResult) // oss_sync_status (refresh)

      await useOssSyncStore.getState().syncNow('/workspace/path')

      expect(mockInvoke).toHaveBeenCalledWith('oss_sync_now', {
        workspacePath: '/workspace/path',
      })
      expect(useOssSyncStore.getState().syncing).toBe(false)
      expect(useOssSyncStore.getState().lastError).toBeNull()
    })

    it('sets lastError and clears syncing on throw', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('sync failed'))

      await useOssSyncStore.getState().syncNow('/workspace/path')

      const state = useOssSyncStore.getState()
      expect(state.syncing).toBe(false)
      expect(state.lastError).toMatch('sync failed')
    })
  })

  // ── createTeam ───────────────────────────────────────────────────────────

  describe('createTeam', () => {
    it('returns teamSecret and updates teamId in store', async () => {
      mockInvoke.mockResolvedValueOnce({
        teamId: 'team-new',
        teamSlug: 'my-team',
        aiGatewayEndpoint: 'https://gw.example.com',
        litellmKey: 'sk-test',
        teamSecret: 'deadbeef1234',
      })

      const result = await useOssSyncStore
        .getState()
        .createTeam('My Team', '/workspace/path')

      expect(mockInvoke).toHaveBeenCalledWith('oss_sync_create_team', {
        name: 'My Team',
        workspacePath: '/workspace/path',
      })
      expect(result.teamSecret).toBe('deadbeef1234')
      expect(result.teamId).toBe('team-new')
      expect(useOssSyncStore.getState().teamId).toBe('team-new')
    })
  })

  // ── listVersions ─────────────────────────────────────────────────────────

  describe('listVersions', () => {
    it('calls oss_sync_list_versions and returns array', async () => {
      const versions = [
        {
          version: 2,
          contentHash: 'abc123',
          size: 512,
          deleted: false,
          createdAt: '2026-05-27T10:00:00Z',
          message: null,
        },
        {
          version: 1,
          contentHash: 'def456',
          size: 480,
          deleted: false,
          createdAt: '2026-05-26T10:00:00Z',
          message: 'initial',
        },
      ]
      mockInvoke.mockResolvedValueOnce(versions)

      const result = await useOssSyncStore
        .getState()
        .listVersions('/workspace/path', 'notes/foo.md')

      expect(mockInvoke).toHaveBeenCalledWith('oss_sync_list_versions', {
        workspacePath: '/workspace/path',
        path: 'notes/foo.md',
      })
      expect(result).toHaveLength(2)
      expect(result[0].contentHash).toBe('abc123')
    })
  })

  // ── restoreVersion ───────────────────────────────────────────────────────

  describe('restoreVersion', () => {
    it('calls oss_sync_restore_version with correct args', async () => {
      mockInvoke.mockResolvedValueOnce(undefined)

      await useOssSyncStore
        .getState()
        .restoreVersion('/workspace/path', 'notes/foo.md', 'abc123')

      expect(mockInvoke).toHaveBeenCalledWith('oss_sync_restore_version', {
        workspacePath: '/workspace/path',
        path: 'notes/foo.md',
        contentHash: 'abc123',
      })
    })
  })

  // ── resolveConflict ──────────────────────────────────────────────────────

  describe('resolveConflict', () => {
    it('calls oss_sync_resolve_conflict with keepRemote', async () => {
      mockInvoke.mockResolvedValueOnce(undefined)

      await useOssSyncStore
        .getState()
        .resolveConflict('/workspace/path', 'notes/foo.md', 'keepRemote')

      expect(mockInvoke).toHaveBeenCalledWith('oss_sync_resolve_conflict', {
        workspacePath: '/workspace/path',
        path: 'notes/foo.md',
        choice: 'keepRemote',
      })
    })

    it('calls oss_sync_resolve_conflict with keepLocal', async () => {
      mockInvoke.mockResolvedValueOnce(undefined)

      await useOssSyncStore
        .getState()
        .resolveConflict('/workspace/path', 'notes/foo.md', 'keepLocal')

      expect(mockInvoke).toHaveBeenCalledWith('oss_sync_resolve_conflict', {
        workspacePath: '/workspace/path',
        path: 'notes/foo.md',
        choice: 'keepLocal',
      })
    })
  })
})
