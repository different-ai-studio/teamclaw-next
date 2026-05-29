import { create } from 'zustand'
import {
  encodeWorkspaceId,
  getDaemonMcp,
  putDaemonMcp,
  type DaemonMcpServerConfig,
} from '@/lib/daemon-local-client'
import { withAsync } from '@/lib/store-utils'
import { useWorkspaceStore } from './workspace'

function getWorkspaceId(): string | null {
  const workspacePath = useWorkspaceStore.getState().workspacePath
  return workspacePath ? encodeWorkspaceId(workspacePath) : null
}

// MCPServerConfig is re-exported so callers don't need to import from daemon-local-client.
export type MCPServerConfig = DaemonMcpServerConfig

export interface MCPTestResult {
  success: boolean
  message: string
  details?: string
}

export interface MCPServer {
  name: string
  config: MCPServerConfig
}

interface MCPState {
  servers: Record<string, MCPServerConfig>
  isLoading: boolean
  error: string | null
  testingServers: Record<string, boolean>
  testResults: Record<string, MCPTestResult>

  loadConfig: () => Promise<void>
  addServer: (name: string, config: MCPServerConfig) => Promise<void>
  updateServer: (name: string, config: MCPServerConfig) => Promise<void>
  removeServer: (name: string) => Promise<void>
  toggleServer: (name: string, enabled: boolean) => Promise<void>
  clearError: () => void
  clearTestResult: (name: string) => void
  /** Re-read MCP config from daemon (replaces legacy file-sync). */
  syncFromFile: () => Promise<void>
}

export const useMCPStore = create<MCPState>((set, get) => ({
  servers: {},
  isLoading: false,
  error: null,
  testingServers: {},
  testResults: {},

  loadConfig: async () => {
    await withAsync(set, async () => {
      const wid = getWorkspaceId()
      if (!wid) return
      const servers = await getDaemonMcp(wid)
      if (servers !== null) set({ servers })
    })
  },

  addServer: async (name: string, config: MCPServerConfig) => {
    await withAsync(set, async () => {
      const wid = getWorkspaceId()
      if (!wid) throw new Error('no workspace')
      const current = get().servers
      const updated = { ...current, [name]: config }
      await putDaemonMcp(wid, updated)
      set({ servers: updated })
    }, { rethrow: true })
  },

  updateServer: async (name: string, config: MCPServerConfig) => {
    await withAsync(set, async () => {
      const wid = getWorkspaceId()
      if (!wid) throw new Error('no workspace')
      const current = get().servers
      const updated = { ...current, [name]: config }
      await putDaemonMcp(wid, updated)
      set({ servers: updated })
    }, { rethrow: true })
  },

  removeServer: async (name: string) => {
    await withAsync(set, async () => {
      const wid = getWorkspaceId()
      if (!wid) throw new Error('no workspace')
      const current = { ...get().servers }
      delete current[name]
      await putDaemonMcp(wid, current)
      set({ servers: current })
    }, { rethrow: true })
  },

  toggleServer: async (name: string, enabled: boolean) => {
    await withAsync(set, async () => {
      const wid = getWorkspaceId()
      if (!wid) throw new Error('no workspace')
      const current = get().servers
      if (!(name in current)) return
      const updated = { ...current, [name]: { ...current[name], enabled } }
      await putDaemonMcp(wid, updated)
      set({ servers: updated })
    }, { rethrow: true })
  },

  clearError: () => set({ error: null }),

  clearTestResult: (name: string) => {
    set((state) => {
      const newResults = { ...state.testResults }
      delete newResults[name]
      return { testResults: newResults }
    })
  },

  syncFromFile: async () => {
    const wid = getWorkspaceId()
    if (!wid) return
    try {
      const servers = await getDaemonMcp(wid)
      if (servers !== null) set({ servers })
    } catch (error) {
      console.error('[MCP] syncFromFile failed:', error)
    }
  },
}))
