import { create as createProtoMessage, toBinary } from '@bufbuild/protobuf'
import { supabase } from '@/lib/supabase-client'
import { runtimeStart } from '@/lib/teamclaw-rpc'
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
 * Inserts the supabase rows needed to materialise a new session and its
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

  const { error: sessionErr } = await supabase
    .from('sessions')
    .insert({
      id: sessionId,
      team_id: args.teamId,
      created_by_actor_id: args.creatorActorId,
      mode: 'collab',
      title: trimmedTitle,
      idea_id: args.ideaId ?? null,
    })
  if (sessionErr) throw new Error(`Failed to create session: ${sessionErr.message}`)

  const participantActorIds = Array.from(new Set([args.creatorActorId, ...args.additionalActorIds]))
  if (participantActorIds.length > 0) {
    const rows = participantActorIds.map(actorId => ({ session_id: sessionId, actor_id: actorId }))
    const { error: partErr } = await supabase.from('session_participants').insert(rows)
    if (partErr) throw new Error(`Failed to add participants: ${partErr.message}`)
  }

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
      await upsertSessionsBatch([sessionRow])
      if (partRows.length > 0) await upsertSessionParticipantsBatch(partRows)
    } catch (e) {
      console.warn('[session-create] local cache upsert failed (non-fatal):', e)
    }
  }

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

  const { error: insertError } = await supabase.from('messages').insert({
    id: messageId,
    team_id: args.teamId,
    session_id: sessionId,
    sender_actor_id: args.creatorActorId,
    kind: 'text',
    content: trimmed,
    metadata: { mention_actor_ids: [] },
  })
  if (insertError) {
    throw new Error(`Failed to persist message: ${insertError.message}`)
  }

  await mqttPublish(
    `amux/${args.teamId}/session/${sessionId}/live`,
    toBinary(LiveEventEnvelopeSchema, liveEnvelope),
    false,
  ).catch((publishErr) => {
    console.warn('[session-create] MQTT publish failed (non-fatal):', publishErr)
  })

  if (args.agentActorIds.length > 0) {
    void startAgentRuntimesAsync({
      sessionId,
      teamId: args.teamId,
      agentActorIds: args.agentActorIds,
    })
  }

  return { sessionId }
}

export interface StartAgentRuntimesArgs {
  sessionId: string
  teamId: string
  agentActorIds: string[]
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

  const priorByAgent = new Map<string, { workspace_id: string | null; backend_type: string | null }>()
  const { data: priorRows } = await supabase
    .from('agent_runtimes')
    .select('agent_id, workspace_id, backend_type, updated_at')
    .in('agent_id', args.agentActorIds)
    .eq('team_id', args.teamId)
    .order('updated_at', { ascending: false })
  for (const r of priorRows ?? []) {
    if (!priorByAgent.has(r.agent_id)) {
      priorByAgent.set(r.agent_id, {
        workspace_id: r.workspace_id,
        backend_type: r.backend_type ?? null,
      })
    }
  }

  // Fetch each agent's explicitly-set default_agent_type — it wins over the
  // prior runtime's backend_type because the operator may have changed the
  // default after the last spawn (or there is no prior spawn at all).
  // agent_kind / default_agent_type live on public.agents (actors only carries
  // the shared identity/display fields). Query agents directly so private
  // agents that aren't team-visible still resolve their backend defaults.
  const defaultByAgent = new Map<string, { agent_kind: string | null; default_agent_type: string | null }>()
  const { data: agentRows } = await supabase
    .from('agents')
    .select('id, agent_kind, default_agent_type')
    .in('id', args.agentActorIds)
  for (const r of agentRows ?? []) {
    defaultByAgent.set(r.id, {
      agent_kind: r.agent_kind ?? null,
      default_agent_type: r.default_agent_type ?? null,
    })
  }

  await Promise.all(args.agentActorIds.map(async (agentActorId) => {
    const prior = priorByAgent.get(agentActorId)
    const agentDefaults = defaultByAgent.get(agentActorId)
    const agentType = resolveAmuxAgentType(
      agentDefaults?.default_agent_type ?? prior?.backend_type ?? null,
      agentDefaults?.agent_kind ?? null,
    )
    try {
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
      })
      if (!result.accepted) {
        console.error('[session-create] runtimeStart rejected', {
          agentActorId,
          reason: result.rejectedReason,
        })
      } else {
        console.info('[session-create] runtimeStart accepted', {
          agentActorId,
          runtimeId: result.runtimeId,
        })
      }
    } catch (e) {
      console.error('[session-create] runtimeStart threw', {
        agentActorId,
        reason: e instanceof Error ? e.message : String(e),
      })
    }
  }))
}
