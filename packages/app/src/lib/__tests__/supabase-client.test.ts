import { beforeEach, describe, expect, it, vi } from 'vitest'

const createClientMock = vi.hoisted(() => vi.fn(() => ({ auth: {} })))

vi.mock('@supabase/supabase-js', () => ({
  createClient: createClientMock,
}))

describe('supabase client configuration', () => {
  beforeEach(() => {
    vi.resetModules()
    createClientMock.mockClear()
    localStorage.clear()
    delete window.__TEAMCLAW_SERVER_CONFIG__
  })

  it('does not throw during module load when Supabase config is missing', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')

    await expect(import('../supabase-client')).resolves.toHaveProperty('supabase')

    expect(createClientMock).toHaveBeenCalledWith(
      'http://127.0.0.1:54321',
      'missing-supabase-anon-key',
      expect.objectContaining({
        auth: expect.objectContaining({ persistSession: true }),
      }),
    )
  })

  it('uses saved Supabase config before environment config', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://env.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'env-key')
    localStorage.setItem(
      'teamclaw.serverConfig',
      JSON.stringify({
        supabaseUrl: 'https://saved.supabase.co',
        supabaseAnonKey: 'saved-key',
      }),
    )

    await import('../supabase-client')

    expect(createClientMock).toHaveBeenCalledWith(
      'https://saved.supabase.co',
      'saved-key',
      expect.any(Object),
    )
  })

  it('uses native-injected Supabase config before localStorage and environment config', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://env.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'env-key')
    localStorage.setItem(
      'teamclaw.serverConfig',
      JSON.stringify({
        supabaseUrl: 'https://saved.supabase.co',
        supabaseAnonKey: 'saved-key',
      }),
    )
    window.__TEAMCLAW_SERVER_CONFIG__ = {
      supabaseUrl: 'https://native.supabase.co',
      supabaseAnonKey: 'native-key',
    }

    await import('../supabase-client')

    expect(createClientMock).toHaveBeenCalledWith(
      'https://native.supabase.co',
      'native-key',
      expect.any(Object),
    )
  })
})
