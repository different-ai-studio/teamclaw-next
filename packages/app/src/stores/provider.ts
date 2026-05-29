import { create } from 'zustand'
import { toast } from 'sonner'
import { appShortName } from '@/lib/build-config'
import { invoke } from '@tauri-apps/api/core'
import { workspaceScopedKey } from '@/lib/storage'
import { sessionFlowLog } from '@/lib/session-flow-log'
import { useWorkspaceStore } from '@/stores/workspace'
import {
  encodeWorkspaceId,
  putDaemonProviderAuth,
  deleteDaemonProviderAuth,
  getDaemonProviders,
  type DaemonProviderInfo,
} from '@/lib/daemon-local-client'
import {
  type CustomProviderConfig,
  getCustomProviderConfig,
  getCustomProviderIds,
  providerApiKeyName,
} from '@/lib/opencode/config'

const SELECTED_MODEL_BASE = `${appShortName}-selected-model`

function selectedModelStorageKey(): string {
  return workspaceScopedKey(SELECTED_MODEL_BASE, useWorkspaceStore.getState().workspacePath)
}

// Read the saved model, preferring the workspace-scoped key but falling back
// to the legacy unscoped key for users upgrading from before workspace scoping.
function readSavedSelectedModel(): string | null {
  const scoped = localStorage.getItem(selectedModelStorageKey())
  if (scoped !== null) return scoped
  return localStorage.getItem(SELECTED_MODEL_BASE)
}

function daemonProvidersToConfigured(
  daemonProviders: DaemonProviderInfo[],
  disconnectedIds: Set<string>,
): { configuredProviders: ConfiguredProvider[]; providers: ProviderEntry[] } {
  const configuredProviders: ConfiguredProvider[] = daemonProviders
    .filter((p) => p.authenticated && !disconnectedIds.has(p.id))
    .map((p) => ({
      id: p.id,
      name: p.display_name,
      models: p.models.map((modelId) => ({ id: modelId, name: modelId })),
    }))

  const providers: ProviderEntry[] = daemonProviders.map((p) => ({
    id: p.id,
    name: p.display_name,
    configured: p.authenticated && !disconnectedIds.has(p.id),
  }))

  providers.sort((a, b) => {
    if (a.configured !== b.configured) return a.configured ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return { configuredProviders, providers }
}

async function loadDaemonProviderSnapshot(disconnectedIds: Set<string>): Promise<{
  configuredProviders: ConfiguredProvider[]
  providers: ProviderEntry[]
} | null> {
  const workspacePath = useWorkspaceStore.getState().workspacePath
  if (!workspacePath) return null
  const daemonProviders = await getDaemonProviders(encodeWorkspaceId(workspacePath))
  if (daemonProviders === null) return null
  return daemonProvidersToConfigured(daemonProviders, disconnectedIds)
}

export interface ProviderAuthMethod {
  type: 'oauth' | 'api'
  label: string
  prompts?: unknown[]
}

// A model option available for selection in the ChatPanel
export interface ModelOption {
  id: string
  name: string
  provider: string
}

// Provider entry for the Settings provider list
export interface ProviderEntry {
  id: string
  name: string
  configured: boolean // true if in the `connected` list
}

// Configured provider with full model info (from GET /config/providers)
export interface ConfiguredProvider {
  id: string
  name: string
  models: Array<{ id: string; name: string }>
}

function flattenConfiguredProviders(configuredProviders: ConfiguredProvider[]): ModelOption[] {
  return configuredProviders.flatMap((provider) =>
    provider.models.map((model) => ({
      id: model.id,
      name: model.name,
      provider: provider.id,
    })),
  )
}

function mergeConfiguredProviders(...groups: ConfiguredProvider[][]): ConfiguredProvider[] {
  const merged = new Map<string, { id: string; name: string; models: Map<string, { id: string; name: string }> }>()

  for (const providers of groups) {
    for (const provider of providers) {
      const existing =
        merged.get(provider.id) ??
        { id: provider.id, name: provider.name, models: new Map<string, { id: string; name: string }>() }

      existing.name = provider.name
      for (const model of provider.models) {
        existing.models.set(model.id, { ...model })
      }

      merged.set(provider.id, existing)
    }
  }

  return Array.from(merged.values()).map((provider) => ({
    id: provider.id,
    name: provider.name,
    models: Array.from(provider.models.values()),
  }))
}

function mergeProviders(...groups: ProviderEntry[][]): ProviderEntry[] {
  const merged = new Map<string, ProviderEntry>()

  for (const providers of groups) {
    for (const provider of providers) {
      const existing = merged.get(provider.id)
      merged.set(provider.id, existing
        ? {
            ...existing,
            ...provider,
            configured: existing.configured || provider.configured,
          }
        : { ...provider })
    }
  }

  return Array.from(merged.values()).sort((a, b) => {
    if (a.configured !== b.configured) return a.configured ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export interface ProviderState {
  // All available providers (from GET /provider), with configured status
  providers: ProviderEntry[]
  providersLoading: boolean

  // Configured providers with model details (from GET /config/providers)
  configuredProviders: ConfiguredProvider[]
  configuredProvidersLoading: boolean

  // Flattened model list built from configuredProviders
  models: ModelOption[]

  // Currently selected model (from GET /config)
  currentModelKey: string | null // format: "providerId/modelId"

  // Auth methods per provider (from GET /provider/auth)
  authMethods: Record<string, ProviderAuthMethod[]>

  // Custom provider IDs (defined in the legacy workspace config)
  customProviderIds: string[]

  // Provider IDs disconnected in the current session. The agent runtime reports
  // custom providers (defined in the legacy workspace config) as "connected"
  // even after auth is removed, so we track them here and filter during refreshes.
  _disconnectedIds: Set<string>

  // Actions
  refreshAuthMethods: () => Promise<void>
  connectProviderOAuth: (providerId: string, methodIndex: number) => Promise<
    { status: 'pending'; url: string; instructions: string; methodType: 'auto' | 'code' } |
    { status: 'success' } |
    { status: 'error'; message: string }
  >
  completeOAuthCallback: (providerId: string, methodIndex: number, code?: string) => Promise<boolean>
  refreshProviders: () => Promise<void>
  refreshConfiguredProviders: () => Promise<void>
  refreshCurrentModel: () => Promise<void>
  refreshCustomProviderIds: (workspacePath: string) => Promise<void>
  connectProvider: (providerId: string, apiKey: string) => Promise<boolean>
  disconnectProvider: (providerId: string) => Promise<boolean>
  addCustomProvider: (workspacePath: string, config: CustomProviderConfig, apiKey: string) => Promise<string | null>
  updateCustomProvider: (workspacePath: string, providerId: string, config: CustomProviderConfig) => Promise<boolean>
  getCustomProvider: (workspacePath: string, providerId: string) => Promise<CustomProviderConfig | null>
  removeCustomProvider: (workspacePath: string, providerId: string) => Promise<boolean>
  selectModel: (providerId: string, modelId: string, modelName: string) => Promise<void>
  initAll: () => Promise<void>
}

export const useProviderStore = create<ProviderState>((set, get) => ({
  // Initial state
  authMethods: {},
  providers: [],
  providersLoading: false,
  configuredProviders: [],
  configuredProvidersLoading: false,
  models: [],
  currentModelKey: null,
  customProviderIds: [],
  _disconnectedIds: new Set<string>(),

  refreshAuthMethods: async () => {
    set({ authMethods: {} })
  },

  connectProviderOAuth: async () => ({
    status: 'error' as const,
    message: 'OAuth provider login is not available without the legacy OpenCode sidecar',
  }),

  completeOAuthCallback: async () => {
    toast.error('OAuth login failed', { description: 'OAuth is not available via the daemon control plane yet' })
    return false
  },

  refreshProviders: async () => {
    set({ providersLoading: true })
    try {
      const snapshot = await loadDaemonProviderSnapshot(get()._disconnectedIds)
      if (!snapshot) {
        set({ providersLoading: false })
        return
      }
      set({ providers: snapshot.providers, providersLoading: false })
    } catch (err) {
      console.error('Failed to load providers:', err)
      set({ providersLoading: false })
    }
  },

  refreshConfiguredProviders: async () => {
    set({ configuredProvidersLoading: true })
    try {
      const snapshot = await loadDaemonProviderSnapshot(get()._disconnectedIds)
      if (!snapshot) {
        set({ configuredProvidersLoading: false })
        return
      }
      set({
        configuredProviders: snapshot.configuredProviders,
        models: flattenConfiguredProviders(snapshot.configuredProviders),
        configuredProvidersLoading: false,
      })
    } catch (err) {
      console.error('Failed to load configured providers:', err)
      set({ configuredProvidersLoading: false })
    }
  },

  refreshCurrentModel: async () => {
    const saved = readSavedSelectedModel()
    if (saved) set({ currentModelKey: saved })
  },

  connectProvider: async (providerId: string, apiKey: string) => {
    const workspacePath = useWorkspaceStore.getState().workspacePath
    if (!workspacePath) {
      toast.error('No workspace selected')
      return false
    }
    try {
      const isRef = /^\$\{?.+\}?$/.test(apiKey)
      if (apiKey && !isRef) {
        await invoke('env_var_set', {
          key: providerApiKeyName(providerId),
          value: apiKey,
          description: `API key for provider ${providerId}`,
        })
      }
      await putDaemonProviderAuth(encodeWorkspaceId(workspacePath), providerId, { api_key: apiKey })
      if (providerId !== 'team') {
        toast.success('Provider connected', { description: `Successfully connected ${providerId}` })
      }
      set((state) => {
        const newDisconnected = new Set(state._disconnectedIds)
        newDisconnected.delete(providerId)
        return { _disconnectedIds: newDisconnected }
      })
      await Promise.all([get().refreshProviders(), get().refreshConfiguredProviders()])
      return true
    } catch (err) {
      console.error('[LLM connect] Failed to connect provider:', err)
      toast.error('Failed to connect provider', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
      return false
    }
  },

  disconnectProvider: async (providerId: string) => {
    const workspacePath = useWorkspaceStore.getState().workspacePath
    if (!workspacePath) {
      toast.error('No workspace selected')
      return false
    }
    try {
      await deleteDaemonProviderAuth(encodeWorkspaceId(workspacePath), providerId)
      toast.success('Provider disconnected', { description: `Successfully disconnected ${providerId}` })
      set((state) => {
        const newDisconnected = new Set(state._disconnectedIds)
        newDisconnected.add(providerId)
        return {
          _disconnectedIds: newDisconnected,
          providers: state.providers
            .map((p) => (p.id === providerId ? { ...p, configured: false } : p))
            .sort((a, b) => {
              if (a.configured !== b.configured) return a.configured ? -1 : 1
              return a.name.localeCompare(b.name)
            }),
          configuredProviders: state.configuredProviders.filter((p) => p.id !== providerId),
          models: state.models.filter((m) => m.provider !== providerId),
        }
      })
      return true
    } catch (err) {
      console.error('Failed to disconnect provider:', err)
      toast.error('Failed to disconnect provider', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
      return false
    }
  },

  // Refresh custom provider IDs. Tries daemon first; falls back to config.ts.
  refreshCustomProviderIds: async (workspacePath: string) => {
    const wsId = encodeWorkspaceId(workspacePath)
    try {
      const daemonProviders = await getDaemonProviders(wsId)
      if (daemonProviders !== null) {
        set({ customProviderIds: daemonProviders.map((p) => p.id) })
        return
      }
    } catch {
      // fall through to legacy
    }
    try {
      const ids = await getCustomProviderIds(workspacePath)
      set({ customProviderIds: ids })
    } catch (err) {
      console.error('Failed to load custom provider IDs:', err)
    }
  },

  // Add a custom OpenAI-compatible provider via daemon workspace-control API.
  addCustomProvider: async (workspacePath: string, config: CustomProviderConfig, apiKey: string) => {
    const wsId = encodeWorkspaceId(workspacePath)
    const providerId = `custom-${config.name.toLowerCase().replace(/\s+/g, '-')}`
    try {
      // Store API key in keychain (env_var_set) for ${ref} resolution at startup.
      const isRef = /^\$\{?.+\}?$/.test(apiKey)
      if (apiKey && !isRef) {
        const keyName = providerApiKeyName(providerId)
        await invoke('env_var_set', { key: keyName, value: apiKey, description: `API key for provider ${config.name}` })
      }
      await putDaemonProviderAuth(wsId, providerId, {
        api_key: apiKey || '',
        base_url: config.baseUrl || undefined,
        display_name: config.name,
        models: config.models.map((m) => ({ model_id: m.modelId, model_name: m.modelName })),
      })
      toast.success('Custom provider added', {
        description: `${config.name} has been added. Restarting agent...`,
      })
      return providerId
    } catch (err) {
      console.error('Failed to add custom provider:', err)
      toast.error('Failed to add custom provider', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
      return null
    }
  },

  // Update an existing custom provider via daemon workspace-control API.
  updateCustomProvider: async (workspacePath: string, providerId: string, config: CustomProviderConfig) => {
    const wsId = encodeWorkspaceId(workspacePath)
    try {
      if (config.apiKey && !/^\$\{?.+\}?$/.test(config.apiKey)) {
        const keyName = providerApiKeyName(providerId)
        await invoke('env_var_set', { key: keyName, value: config.apiKey, description: `API key for provider ${config.name}` })
      }
      await putDaemonProviderAuth(wsId, providerId, {
        api_key: config.apiKey || '',
        base_url: config.baseUrl || undefined,
        display_name: config.name,
        models: config.models.map((m) => ({ model_id: m.modelId, model_name: m.modelName })),
      })
      toast.success('Custom provider updated', {
        description: `${config.name} has been updated. Restarting agent...`,
      })
      return true
    } catch (err) {
      console.error('Failed to update custom provider:', err)
      toast.error('Failed to update custom provider', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
      return false
    }
  },

  // Get a custom provider config. Tries daemon first; falls back to config.ts.
  getCustomProvider: async (workspacePath: string, providerId: string) => {
    const wsId = encodeWorkspaceId(workspacePath)
    try {
      const providers = await getDaemonProviders(wsId)
      if (providers !== null) {
        const p = providers.find((x) => x.id === providerId)
        if (!p) return null
        return {
          name: p.display_name,
          baseUrl: p.base_url ?? '',
          models: p.models.map((id) => ({ modelId: id, modelName: id })),
        } satisfies CustomProviderConfig
      }
    } catch {
      // fall through
    }
    try {
      return await getCustomProviderConfig(workspacePath, providerId)
    } catch (err) {
      console.error('Failed to get custom provider:', err)
      return null
    }
  },

  // Remove a custom provider via daemon workspace-control API.
  removeCustomProvider: async (workspacePath: string, providerId: string) => {
    const wsId = encodeWorkspaceId(workspacePath)
    try {
      await deleteDaemonProviderAuth(wsId, providerId)
      toast.success('Custom provider removed', {
        description: `Provider has been removed. Restarting agent...`,
      })
      return true
    } catch (err) {
      console.error('Failed to remove custom provider:', err)
      toast.error('Failed to remove custom provider', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
      return false
    }
  },

  // Select a model for the OpenCode-backed settings/chat UI.
  selectModel: async (providerId: string, modelId: string, _modelName: string) => {
    const modelKey = `${providerId}/${modelId}`
    set({ currentModelKey: modelKey })

    // Cache in workspace-scoped localStorage as fallback
    localStorage.setItem(selectedModelStorageKey(), modelKey)
  },

  // Initialize all data at once
  initAll: async () => {
    await Promise.all([
      get().refreshProviders().catch(() => undefined),
      get().refreshConfiguredProviders().catch(() => undefined),
      get().refreshCurrentModel().catch(() => undefined),
    ])

    const workspacePath = useWorkspaceStore.getState().workspacePath
    if (workspacePath) {
      await get().refreshCustomProviderIds(workspacePath).catch(() => undefined)
    }

    const { currentModelKey } = get()
    const availableModels = get().models

    let resolvedKey = currentModelKey
    let resolvedSource = resolvedKey ? 'currentModelKey' : 'none'

    if (!resolvedKey || !availableModels.find((m) => `${m.provider}/${m.id}` === resolvedKey)) {
      const saved = readSavedSelectedModel()
      if (saved && availableModels.find((m) => `${m.provider}/${m.id}` === saved)) {
        resolvedKey = saved
        resolvedSource = 'localStorage'
      } else if (availableModels.length > 0) {
        resolvedKey = `${availableModels[0].provider}/${availableModels[0].id}`
        resolvedSource = 'firstAvailable'
      } else {
        resolvedKey = null
        resolvedSource = 'none'
      }
    }

    sessionFlowLog('provider.init_all.resolve_model', {
      currentModelKey,
      resolvedKey,
      resolvedSource,
      availableModelKeys: availableModels.map((model) => `${model.provider}/${model.id}`),
    })

    if (resolvedKey) {
      set({ currentModelKey: resolvedKey })
      // Sync workspace-scoped localStorage to be consistent
      localStorage.setItem(selectedModelStorageKey(), resolvedKey)
    } else {
      set({ currentModelKey: null })
    }
  },
}))

// Helper: split "providerId/modelId" safely – modelId itself may contain '/'
function splitModelKey(key: string): [string, string] | null {
  const idx = key.indexOf('/')
  if (idx === -1) return null
  return [key.substring(0, idx), key.substring(idx + 1)]
}

// Helper: get the currently selected ModelOption from the store
export function getSelectedModelOption(state: ProviderState): ModelOption | null {
  if (!state.currentModelKey) return null
  const parts = splitModelKey(state.currentModelKey)
  if (!parts) return null
  const [providerId, modelId] = parts
  return state.models.find((m) => m.provider === providerId && m.id === modelId) || null
}

export function getModelOptionsForSelectedBackend(
  state: Pick<ProviderState, 'models' | 'currentModelKey'>,
): ModelOption[] {
  if (!state.currentModelKey) return state.models
  const parts = splitModelKey(state.currentModelKey)
  if (!parts) return state.models
  const [providerId] = parts
  return state.models.filter((m) => m.provider === providerId)
}
