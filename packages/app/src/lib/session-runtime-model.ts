import { supabase } from '@/lib/supabase-client'
import { setModel } from '@/lib/teamclaw-rpc'
import { sessionFlowError, sessionFlowLog } from '@/lib/session-flow-log'

export interface ApplySessionRuntimeModelArgs {
  sessionId: string | null
  agentActorIds: string[]
  modelId: string
}

export async function applySessionRuntimeModel(args: ApplySessionRuntimeModelArgs): Promise<void> {
  sessionFlowLog('runtime_model.apply.begin', {
    sessionId: args.sessionId,
    requestedAgentActorIds: args.agentActorIds,
    requestedAgentCount: args.agentActorIds.length,
    modelId: args.modelId,
  })

  if (!args.sessionId || !args.modelId) {
    sessionFlowLog('runtime_model.apply.skipped_missing_input', {
      hasSessionId: !!args.sessionId,
      hasModelId: !!args.modelId,
      requestedAgentCount: args.agentActorIds.length,
    }, 'warn')
    return
  }

  let query = supabase
    .from('agent_runtimes')
    .select('agent_id, runtime_id')
    .eq('session_id', args.sessionId)

  if (args.agentActorIds.length > 0) {
    sessionFlowLog('runtime_model.query.filter_agents', {
      sessionId: args.sessionId,
      agentActorIds: args.agentActorIds,
    })
    query = query.in('agent_id', args.agentActorIds)
  } else {
    sessionFlowLog('runtime_model.query.all_session_agents', {
      sessionId: args.sessionId,
    })
  }

  const { data, error } = await query

  if (error) {
    sessionFlowError('runtime_model.query.failed', error, {
      sessionId: args.sessionId,
      modelId: args.modelId,
      agentActorIds: args.agentActorIds,
    })
    throw new Error(`Failed to load agent runtimes: ${error.message}`)
  }

  const runtimeRows = ((data ?? []) as Array<{ agent_id: string | null; runtime_id: string | null }>)
  const validRuntimeRows = runtimeRows.filter(
    (row): row is { agent_id: string; runtime_id: string } => !!row.agent_id && !!row.runtime_id,
  )

  sessionFlowLog('runtime_model.query.ok', {
    sessionId: args.sessionId,
    modelId: args.modelId,
    rowCount: runtimeRows.length,
    validRowCount: validRuntimeRows.length,
    rows: runtimeRows.map((row) => ({
      agentId: row.agent_id,
      runtimeId: row.runtime_id,
      valid: !!row.agent_id && !!row.runtime_id,
    })),
  })

  await Promise.all(
    validRuntimeRows.map(async (row) => {
      sessionFlowLog('runtime_model.set_model.begin', {
        sessionId: args.sessionId,
        targetDeviceId: row.agent_id,
        runtimeId: row.runtime_id,
        modelId: args.modelId,
      })
      try {
        const result = await setModel({
          targetDeviceId: row.agent_id,
          runtimeId: row.runtime_id,
          modelId: args.modelId,
        })
        sessionFlowLog('runtime_model.set_model.ok', {
          sessionId: args.sessionId,
          targetDeviceId: row.agent_id,
          runtimeId: row.runtime_id,
          modelId: args.modelId,
          result,
        })
      } catch (error) {
        sessionFlowError('runtime_model.set_model.failed', error, {
          sessionId: args.sessionId,
          targetDeviceId: row.agent_id,
          runtimeId: row.runtime_id,
          modelId: args.modelId,
        })
        throw error
      }
    }),
  )

  sessionFlowLog('runtime_model.apply.done', {
    sessionId: args.sessionId,
    modelId: args.modelId,
    appliedRuntimeCount: validRuntimeRows.length,
  })
}
