import { invoke } from '@tauri-apps/api/core'
import { initOpenCodeClient } from './sdk-client'
import { useWorkspaceStore } from '@/stores/workspace'

export interface RestartResult {
  url: string
}

// Stop+start the OpenCode sidecar and restore the SDK client URL and ready flags.
// Provider reconciliation for agent runtimes is handled by the daemon via
// `teamclaw-runtime-env::ensure_team_provider` in `prepare_workspace`; this
// path only affects the settings `opencode serve` sidecar.
export async function restartOpencode(workspacePath: string): Promise<RestartResult> {
  const { setOpenCodeBootstrapped, setOpenCodeReady } = useWorkspaceStore.getState()
  setOpenCodeBootstrapped(false)
  await invoke('stop_opencode', { workspacePath })
  await new Promise((resolve) => setTimeout(resolve, 500))
  const status = await invoke<{ url: string }>('start_opencode', {
    config: { workspace_path: workspacePath },
  })
  initOpenCodeClient({ baseUrl: status.url, workspacePath })
  setOpenCodeBootstrapped(true, status.url)
  setOpenCodeReady(true, status.url)
  return { url: status.url }
}
