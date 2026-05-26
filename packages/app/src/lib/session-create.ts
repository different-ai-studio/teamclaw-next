import { create as createProtoMessage, toBinary } from '@bufbuild/protobuf'
import { getBackend } from '@/lib/backend'
import { runtimeStart, setModel } from '@/lib/teamclaw-rpc'
import { resolveAmuxAgentType } from '@/lib/amux-agent-type'
import { mqttPublish } from '@/lib/mqtt-bridge'
import {
  LiveEventEnvelopeSchema,
  MessageKind,
  MessageSchema,
  SessionMessageEnvelopeSchema,
} from '@/lib/proto/teamclaw_pb'
import {
  upsertSessionsBatch,
  upsertSessionParticipantsBatch,
  type SessionRow,
  type SessionParticipantRow,
} from '@/lib/local-cache'
import { isTauri } from '@/lib/utils'
import {
  sessionFlowError,
  sessionFlowLog,
  summarizeText,
} from '@/lib/session-flow-log'

export interface CreateSessionShellArgs {
  teamId: string
  creatorActorId: string
  title: string
  /** Actor IDs to add as participants alongside the creator. */
  additionalActorIds: string[]
  /** When set, the new session row is tagged with this idea_id at insert time. */
  ideaId?: string | null
}

export interface CreateSessionShellResult {
  sessionId: string
}

/**
 * Inserts the backend rows needed to materialise a new session and its
 * initial participants. Does NOT trigger any agent runtimeStart RPC —
 * callers fire-and-forget {@link startAgentRuntimesAsync} afterward so
 * the UI can switch into the new session immediately while runtimes
 * spawn in the background.
 */
export async function createSessionShell(
  args: CreateSessionShellArgs,
): Promise<CreateSessionShellResult> {
  const sessionId = crypto.randomUUID()
  const trimmedTitle = (args.title.split('\n')[0] || args.title).trim().slice(0, 80) || 'New chat'
  sessionFlowLog('session_shell.begin', {
    sessionId,
    teamId: args.teamId,
    creatorActorId: args.creatorActorId,
    additionalActorCount: args.additionalActorIds.length,
    hasIdeaId: !!args.ideaId,
    title: trimmedTitle,
  })

  const participantActorIds = Array.from(new Set([args.creatorActorId, ...args.additionalActorIds]))
  try {
    await getBackend().sessions.createSessionShell({
      id: sessionId,
      teamId: args.teamId,
      createdByActorId: args.creatorActorId,
      title: trimmedTitle,
      additionalActorIds: args.additionalActorIds,
      ideaId: args.ideaId ?? null,
    })
  } catch (error) {
    sessionFlowError('session_shell.create_backend.failed', error, {
      sessionId,
      teamId: args.teamId,
      participantCount: participantActorIds.length,
    })
    throw error
  }
  sessionFlowLog('session_shell.create_backend.ok', {
    sessionId,
    teamId: args.teamId,
    participantCount: participantActorIds.length,
  })

  // Mirror into local libsql immediately so the session-list-store + Actors
  // panel see the new session without waiting for a Supabase refetch.
  if (isTauri()) {
    const now = new Date().toISOString()
    const sessionRow: SessionRow = {
      id: sessionId,
      teamId: args.teamId,
      title: trimmedTitle,
      mode: 'collab',
      primaryAgentId: null,
      ideaId: args.ideaId ?? null,
      summary: null,
      lastMessagePreview: null,
      lastMessageAt: null,
      createdBy: args.creatorActorId,
      metadataJson: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      syncedAt: now,
    }
    const partRows: SessionParticipantRow[] = participantActorIds.map(actorId => ({
      id: `${sessionId}:${actorId}`,
      sessionId,
      actorId,
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      syncedAt: now,
    }))
    try {
      sessionFlowLog('session_shell.local_cache.begin', {
        sessionId,
        teamId: args.teamId,
        participantCount: partRows.length,
      })
      await upsertSessionsBatch([sessionRow])
      if (partRows.length > 0) await upsertSessionParticipantsBatch(partRows)
      sessionFlowLog('session_shell.local_cache.ok', {
        sessionId,
        teamId: args.teamId,
        participantCount: partRows.length,
      })
    } catch (e) {
      sessionFlowError('session_shell.local_cache.failed', e, {
        sessionId,
        teamId: args.teamId,
      })
      console.warn('[session-create] local cache upsert failed (non-fatal):', e)
    }
  }

  sessionFlowLog('session_shell.ok', {
    sessionId,
    teamId: args.teamId,
  })
  return { sessionId }
}

export interface CreateSessionWithFirstMessageArgs {
  teamId: string
  creatorActorId: string
  /** Additional participant actor IDs (members + agents). Creator is added automatically. */
  additionalActorIds: string[]
  /** Subset of `additionalActorIds` that are agents — used to fan out runtime spawns. */
  agentActorIds: string[]
  /** Opening message text. Sent verbatim — no @-mention prefix. */
  messageText: string
  /** Model chosen before creating the session; passed to each started agent runtime. */
  modelId?: string
  /** Backend chosen before creating the session; overrides agent defaults/history. */
  agentType?: number
  ideaId?: string | null
}

export interface CreateSessionWithFirstMessageResult {
  sessionId: string
}

/**
 * One-shot helper that backs the "新会话" dialog: creates the session shell,
 * publishes the opening message via MQTT + Supabase, kicks off runtime spawn
 * for any agents added. The first message intentionally carries no @-mentions
 * (see desktop UX spec — per-agent engagement happens after the user replies
 * inside the session).
 */
export async function createSessionWithFirstMessage(
  args: CreateSessionWithFirstMessageArgs,
): Promise<CreateSessionWithFirstMessageResult> {
  const trimmed = args.messageText.trim()
  if (!trimmed) throw new Error('Opening message cannot be empty')
  sessionFlowLog('session_with_first_message.begin', {
    teamId: args.teamId,
    creatorActorId: args.creatorActorId,
    additionalActorCount: args.additionalActorIds.length,
    agentActorCount: args.agentActorIds.length,
    agentType: args.agentType,
    modelId: args.modelId,
    hasIdeaId: !!args.ideaId,
    ...summarizeText(trimmed),
  })

  const titleSource = trimmed.split('\n')[0]?.trim().slice(0, 80) || 'New chat'

  const { sessionId } = await createSessionShell({
    teamId: args.teamId,
    creatorActorId: args.creatorActorId,
    title: titleSource,
    additionalActorIds: args.additionalActorIds,
    ideaId: args.ideaId ?? null,
  })

  const messageId = crypto.randomUUID()
  const createdAt = BigInt(Math.floor(Date.now() / 1000))

  const protoMessage = createProtoMessage(MessageSchema, {
    messageId,
    sessionId,
    senderActorId: args.creatorActorId,
    kind: MessageKind.TEXT,
    content: trimmed,
    createdAt,
    model: args.modelId ?? '',
  })
  const sessionEnvelope = createProtoMessage(SessionMessageEnvelopeSchema, {
    message: protoMessage,
    mentionActorIds: [],
  })
  const liveEnvelope = createProtoMessage(LiveEventEnvelopeSchema, {
    eventId: crypto.randomUUID(),
    eventType: 'message.created',
    sessionId,
    actorId: args.creatorActorId,
    sentAt: createdAt,
    body: toBinary(SessionMessageEnvelopeSchema, sessionEnvelope),
  })

  try {
    await getBackend().messages.insertOutgoingMessage({
      id: messageId,
      teamId: args.teamId,
      sessionId,
      senderActorId: args.creatorActorId,
      kind: 'text',
      content: trimmed,
      model: args.modelId ?? null,
      metadata: { mention_actor_ids: [] },
    })
  } catch (error) {
    sessionFlowError('session_with_first_message.insert_message.failed', error, {
      sessionId,
      teamId: args.teamId,
      messageId,
    })
    throw error
  }
  sessionFlowLog('session_with_first_message.insert_message.ok', {
    sessionId,
    teamId: args.teamId,
    messageId,
  })

  sessionFlowLog('session_with_first_message.mqtt_publish.begin', {
    sessionId,
    teamId: args.teamId,
    messageId,
    topic: `amux/${args.teamId}/session/${sessionId}/live`,
  })
  await mqttPublish(
    `amux/${args.teamId}/session/${sessionId}/live`,
    toBinary(LiveEventEnvelopeSchema, liveEnvelope),
    false,
  ).catch((publishErr) => {
    sessionFlowError('session_with_first_message.mqtt_publish.failed', publishErr, {
      sessionId,
      teamId: args.teamId,
      messageId,
    })
    console.warn('[session-create] MQTT publish failed (non-fatal):', publishErr)
  })
  sessionFlowLog('session_with_first_message.mqtt_publish.done', {
    sessionId,
    teamId: args.teamId,
    messageId,
  })

  if (args.agentActorIds.length > 0) {
    sessionFlowLog('session_with_first_message.runtime_start.begin', {
      sessionId,
      teamId: args.teamId,
      agentActorIds: args.agentActorIds,
      agentType: args.agentType,
      modelId: args.modelId,
    })
    void startAgentRuntimesAsync({
      sessionId,
      teamId: args.teamId,
      agentActorIds: args.agentActorIds,
      agentType: args.agentType,
      modelId: args.modelId,
    })
  }

  sessionFlowLog('session_with_first_message.ok', {
    sessionId,
    teamId: args.teamId,
    messageId,
  })
  return { sessionId }
}

export interface StartAgentRuntimesArgs {
  sessionId: string
  teamId: string
  agentActorIds: string[]
  agentType?: number
  modelId?: string
}

function normalizeAgentTypes(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((t): t is string => typeof t === 'string' && t.length > 0)
    : []
}

function pickAgentBackend(
  defaultAgentType: string | null | undefined,
  agentTypes: string[],
  priorBackendType: string | null | undefined,
): string | null {
  const normalizedDefault = defaultAgentType === 'claude_code' || defaultAgentType === 'claude-code'
    ? 'claude'
    : defaultAgentType ?? null
  if (normalizedDefault && (agentTypes.length === 0 || agentTypes.includes(normalizedDefault))) {
    return normalizedDefault
  }
  return agentTypes[0] ?? priorBackendType ?? null
}

/**
 * Fire-and-forget RPC fanout. Looks up each agent's prior workspace from
 * agent_runtimes history, then calls runtimeStart per agent. Failures are
 * logged but don't propagate — UI has already moved on.
 *
 * The caller is expected to NOT await this — kick it off with `void`.
 * Daemon-published RuntimeInfo retains will update the runtime-state-store
 * asynchronously as the runtimes come up.
 */
export async function startAgentRuntimesAsync(args: StartAgentRuntimesArgs): Promise<void> {
  if (args.agentActorIds.length === 0) return
  sessionFlowLog('runtime_start.batch.begin', {
    sessionId: args.sessionId,
    teamId: args.teamId,
    agentActorIds: args.agentActorIds,
    agentType: args.agentType,
    modelId: args.modelId,
  })

  const backend = getBackend()
  const priorByAgent = new Map<string, { workspace_id: string | null; backend_type: string | null }>()
  let priorRows: Awaited<ReturnType<typeof backend.runtime.listLatestAgentRuntimeHints>> = []
  try {
    priorRows = await backend.runtime.listLatestAgentRuntimeHints(args.teamId, args.agentActorIds)
  } catch (error) {
    sessionFlowError('runtime_start.lookup_prior.failed', error, {
      sessionId: args.sessionId,
      teamId: args.teamId,
      agentActorIds: args.agentActorIds,
    })
    console.warn('[session-create] runtime hint lookup failed; continuing with fallback values', {
      sessionId: args.sessionId,
      teamId: args.teamId,
      agentActorIds: args.agentActorIds,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  for (const r of priorRows) {
    if (!priorByAgent.has(r.agent_id)) {
      priorByAgent.set(r.agent_id, {
        workspace_id: r.workspace_id,
        backend_type: r.backend_type ?? null,
      })
    }
  }

  // Fetch each agent's advertised supported types and default. The default
  // wins over previous runtime history only when it is present in agent_types.
  const defaultByAgent = new Map<string, { agent_types: string[]; default_agent_type: string | null }>()
  let agentRows: Awaited<ReturnType<typeof backend.runtime.listAgentDefaults>> = []
  try {
    agentRows = await backend.runtime.listAgentDefaults(args.agentActorIds)
  } catch (error) {
    sessionFlowError('runtime_start.lookup_agent_defaults.failed', error, {
      sessionId: args.sessionId,
      teamId: args.teamId,
      agentActorIds: args.agentActorIds,
    })
    console.warn('[session-create] agent defaults lookup failed; continuing with runtime history or fallback values', {
      sessionId: args.sessionId,
      teamId: args.teamId,
      agentActorIds: args.agentActorIds,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  for (const r of agentRows) {
    defaultByAgent.set(r.id, {
      agent_types: normalizeAgentTypes(r.agent_types),
      default_agent_type: r.default_agent_type ?? null,
    })
  }

  await Promise.all(args.agentActorIds.map(async (agentActorId) => {
    const prior = priorByAgent.get(agentActorId)
    const agentDefaults = defaultByAgent.get(agentActorId)
    const backendType = pickAgentBackend(
      agentDefaults?.default_agent_type,
      agentDefaults?.agent_types ?? [],
      prior?.backend_type,
    )
    const agentType = args.agentType ?? resolveAmuxAgentType(backendType)
    try {
      sessionFlowLog('runtime_start.request.begin', {
        sessionId: args.sessionId,
        teamId: args.teamId,
        agentActorId,
        agentType,
        modelId: args.modelId,
        workspaceId: prior?.workspace_id ?? '',
      })
      // Current amuxd convention: daemon device_id == its actor_id, so the
      // RPC topic is amux/{team}/device/{agentActorId}/rpc/req. Multi-daemon
      // teams would need a separate (actor -> deviceId) lookup.
      const result = await runtimeStart({
        targetDeviceId: agentActorId,
        workspaceId: prior?.workspace_id ?? '',
        worktree: '',
        sessionId: args.sessionId,
        agentType,
        initialPrompt: '',
        ...(args.modelId ? { modelId: args.modelId } : {}),
      })
      if (!result.accepted) {
        sessionFlowLog('runtime_start.request.rejected', {
          sessionId: args.sessionId,
          teamId: args.teamId,
          agentActorId,
          modelId: args.modelId,
          reason: result.rejectedReason,
        }, 'warn')
        console.error('[session-create] runtimeStart rejected', {
          agentActorId,
          reason: result.rejectedReason,
        })
      } else {
        sessionFlowLog('runtime_start.request.accepted', {
          sessionId: args.sessionId,
          teamId: args.teamId,
          agentActorId,
          runtimeId: result.runtimeId,
          modelId: args.modelId,
        })
        console.info('[session-create] runtimeStart accepted', {
          agentActorId,
          runtimeId: result.runtimeId,
        })
        if (args.modelId) {
          sessionFlowLog('runtime_start.set_model.begin', {
            sessionId: args.sessionId,
            teamId: args.teamId,
            agentActorId,
            runtimeId: result.runtimeId,
            modelId: args.modelId,
          })
          try {
            await setModel({
              targetDeviceId: agentActorId,
              runtimeId: result.runtimeId,
              modelId: args.modelId,
            })
            sessionFlowLog('runtime_start.set_model.ok', {
              sessionId: args.sessionId,
              teamId: args.teamId,
              agentActorId,
              runtimeId: result.runtimeId,
              modelId: args.modelId,
            })
          } catch (modelErr) {
            sessionFlowError('runtime_start.set_model.failed', modelErr, {
              sessionId: args.sessionId,
              teamId: args.teamId,
              agentActorId,
              runtimeId: result.runtimeId,
              modelId: args.modelId,
            })
            console.warn('[session-create] setModel after runtimeStart failed', {
              agentActorId,
              runtimeId: result.runtimeId,
              modelId: args.modelId,
              reason: modelErr instanceof Error ? modelErr.message : String(modelErr),
            })
          }
        }
      }
    } catch (e) {
      sessionFlowError('runtime_start.request.failed', e, {
        sessionId: args.sessionId,
        teamId: args.teamId,
        agentActorId,
        modelId: args.modelId,
      })
      console.error('[session-create] runtimeStart threw', {
        agentActorId,
        reason: e instanceof Error ? e.message : String(e),
      })
    }
  }))
  sessionFlowLog('runtime_start.batch.done', {
    sessionId: args.sessionId,
    teamId: args.teamId,
    agentActorIds: args.agentActorIds,
    modelId: args.modelId,
  })
}
