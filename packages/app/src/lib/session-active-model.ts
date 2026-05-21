import { supabase } from '@/lib/supabase-client'
import type { RuntimeStateEntry } from '@/stores/runtime-state-store'
import type { ModelOption } from '@/stores/provider'
import { sessionFlowError, sessionFlowLog } from '@/lib/session-flow-log'

type RuntimeRow = {
  runtime_id: string | null
  backend_type: string | null
  current_model: string | null
}

export type SessionModelResolution = {
  provider: string
  modelId: string
  name: string
  source: 'runtimeInfo' | 'agentRuntimes'
}

function providerIdForBackendType(backendType: string | null | undefined): string | null {
  switch (backendType) {
    case 'claude-code':
    case 'claude':
    case 'claude_code':
      return 'claude-code'
    case 'opencode':
      return 'opencode'
    case 'codex':
      return 'codex'
    default:
      return null
  }
}

export function resolveSessionModelFromRuntimeRows(
  rows: RuntimeRow[],
  runtimeStates: Record<string, RuntimeStateEntry>,
  models: ModelOption[],
): SessionModelResolution | null {
  for (const row of rows) {
    const provider = providerIdForBackendType(row.backend_type)
    if (!provider) continue

    const liveModel = row.runtime_id ? runtimeStates[row.runtime_id]?.info.currentModel : ''
    const candidates: Array<{ modelId: string; source: SessionModelResolution['source'] }> = [
      { modelId: liveModel || '', source: 'runtimeInfo' },
      { modelId: row.current_model || '', source: 'agentRuntimes' },
    ]

    for (const candidate of candidates) {
      if (!candidate.modelId) continue
      const model = models.find((m) => m.provider === provider && m.id === candidate.modelId)
      if (model) {
        return {
          provider,
          modelId: model.id,
          name: model.name,
          source: candidate.source,
        }
      }
    }
  }

  return null
}

export async function loadSessionActiveModel(args: {
  sessionId: string
  runtimeStates: Record<string, RuntimeStateEntry>
  models: ModelOption[]
}): Promise<SessionModelResolution | null> {
  sessionFlowLog('session_model.load.begin', {
    sessionId: args.sessionId,
    modelCount: args.models.length,
    runtimeStateCount: Object.keys(args.runtimeStates).length,
  })

  const { data, error } = await supabase
    .from('agent_runtimes')
    .select('runtime_id, backend_type, current_model, updated_at')
    .eq('session_id', args.sessionId)
    .order('updated_at', { ascending: false })

  if (error) {
    sessionFlowError('session_model.load.failed', error, {
      sessionId: args.sessionId,
    })
    return null
  }

  const rows = (data ?? []) as RuntimeRow[]
  const resolved = resolveSessionModelFromRuntimeRows(rows, args.runtimeStates, args.models)

  sessionFlowLog('session_model.load.done', {
    sessionId: args.sessionId,
    rowCount: rows.length,
    resolved,
    rows: rows.map((row) => ({
      runtimeId: row.runtime_id,
      backendType: row.backend_type,
      currentModel: row.current_model,
      liveCurrentModel: row.runtime_id ? args.runtimeStates[row.runtime_id]?.info.currentModel : undefined,
    })),
  })

  return resolved
}
