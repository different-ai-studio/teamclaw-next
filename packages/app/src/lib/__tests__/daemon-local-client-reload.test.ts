import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
}))

const mockInvoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

describe('reloadDaemonRuntime', () => {
  beforeEach(() => {
    vi.resetModules()
    mockInvoke.mockReset()
  })

  it('retries once after a transient network failure', async () => {
    let port = '11111'
    mockInvoke.mockImplementation(async () => ({
      base_url: `http://127.0.0.1:${port}`,
      root_token: 'root',
    }))

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/auth/exchange')) {
        return new Response(JSON.stringify({ token: 'sess', expires_in: 3600 }), { status: 200 })
      }
      if (url.includes('/runtime/reload')) {
        if (port === '11111') {
          port = '22222'
          throw new TypeError('Load failed (127.0.0.1:11111)')
        }
        return new Response(JSON.stringify({ outcome: 'reload_required' }), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { reloadDaemonRuntime, invalidateDaemonConnection } = await import('../daemon-local-client')
    invalidateDaemonConnection()

    await expect(reloadDaemonRuntime('workspace-id')).resolves.toBe('reload_required')
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/runtime/reload'))).toBe(true)
    expect(mockInvoke.mock.calls.length).toBeGreaterThan(1)
  })

  it('throws a readable error when reload stays unavailable', async () => {
    mockInvoke.mockResolvedValue({
      base_url: 'http://127.0.0.1:33333',
      root_token: 'root',
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/v1/auth/exchange')) {
          return new Response(JSON.stringify({ token: 'sess', expires_in: 3600 }), { status: 200 })
        }
        throw new TypeError('Load failed (127.0.0.1:33333)')
      }),
    )

    const { reloadDaemonRuntime, invalidateDaemonConnection } = await import('../daemon-local-client')
    invalidateDaemonConnection()

    await expect(reloadDaemonRuntime('workspace-id')).rejects.toThrow('Load failed')
  })
})
