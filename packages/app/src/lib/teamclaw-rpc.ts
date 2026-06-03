import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import {
  AddWorkspaceRequestSchema,
  FetchWorkspacesRequestSchema,
  RpcRequestSchema,
  RpcResponseSchema,
  RuntimeStartRequestSchema,
  RuntimeStopRequestSchema,
  SetModelRequestSchema,
  type AddWorkspaceResult,
  type FetchWorkspacesResult,
  type RpcRequest,
  type RpcResponse,
  type RuntimeStartResult,
  type RuntimeStopResult,
  type SetModelResult,
} from '@/lib/proto/teamclaw_pb'
import { mqttPublish, mqttSubscribe, listenForEnvelopes, type IncomingEnvelope } from '@/lib/mqtt-bridge'
import { useAuthStore } from '@/stores/auth-store'

// ---------------------------------------------------------------------------
// Module-scoped state
// ---------------------------------------------------------------------------

type Pending = {
  resolve: (res: RpcResponse) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, Pending>()
let teamId: string | null = null
let unlisten: (() => void) | null = null
let initialized = false
const DEFAULT_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Init / dispose
// ---------------------------------------------------------------------------

export function isTeamclawRpcReady(): boolean {
  return initialized && teamId !== null
}

/** Poll until MQTT RPC listener is wired (App.tsx init), or timeout. */
export async function waitForTeamclawRpcReady(timeoutMs = 15_000): Promise<boolean> {
  if (isTeamclawRpcReady()) return true
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
    if (isTeamclawRpcReady()) return true
  }
  return isTeamclawRpcReady()
}

export async function initTeamclawRpc(teamIdArg: string): Promise<void> {
  if (initialized) return
  teamId = teamIdArg
  // Daemon publishes RPC responses to `amux/{team}/{daemon_actor_id}/rpc/res`.
  // Subscribe with a wildcard so any daemon in the team can answer; we correlate
  // by request_id inside the response, so the actor segment doesn't matter for routing.
  await mqttSubscribe(`amux/${teamIdArg}/+/rpc/res`)
  unlisten = await listenForEnvelopes(handleEnvelope)
  initialized = true
}

export function disposeTeamclawRpc(): void {
  unlisten?.()
  unlisten = null
  teamId = null
  for (const p of pending.values()) {
    clearTimeout(p.timer)
    p.reject(new Error('rpc disposed'))
  }
  pending.clear()
  initialized = false
}

// ---------------------------------------------------------------------------
// Envelope handler
// ---------------------------------------------------------------------------

function handleEnvelope(env: IncomingEnvelope): void {
  if (!teamId) return
  // Match `amux/{team}/{any}/rpc/res`.
  const expectedPrefix = `amux/${teamId}/`
  const expectedSuffix = `/rpc/res`
  if (!env.topic.startsWith(expectedPrefix) || !env.topic.endsWith(expectedSuffix)) return
  let response: RpcResponse
  try {
    response = fromBinary(RpcResponseSchema, new Uint8Array(env.bytes))
  } catch (e) {
    console.warn('[teamclaw-rpc] failed to decode RpcResponse', e)
    return
  }
  const p = pending.get(response.requestId)
  if (!p) {
    // Response for a request we don't own (or already timed out). Ignore quietly.
    return
  }
  pending.delete(response.requestId)
  clearTimeout(p.timer)
  p.resolve(response)
}

// ---------------------------------------------------------------------------
// Core send helper
// ---------------------------------------------------------------------------

async function sendRequest(
  build: (req: RpcRequest) => void,
  targetActorId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<RpcResponse> {
  if (!initialized || !teamId) {
    throw new Error('teamclaw-rpc not initialized')
  }
  if (!targetActorId) {
    throw new Error('teamclaw-rpc: targetActorId required')
  }
  const requestId = crypto.randomUUID()
  const session = useAuthStore.getState().session
  const requesterActorId = session?.user?.id ?? ''
  const requesterClientId = `teamclaw-${requesterActorId.slice(0, 8)}-${requestId.slice(0, 8)}`

  const req = create(RpcRequestSchema, {
    requestId,
    senderDeviceId: requesterClientId,
    requesterClientId,
    requesterActorId,
    requesterDeviceId: '', // desktop has no daemon device id of its own
  })
  build(req) // caller fills the method oneof

  return new Promise<RpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`rpc timeout after ${timeoutMs}ms`))
    }, timeoutMs)

    pending.set(requestId, { resolve, reject, timer })

    const topic = `amux/${teamId!}/${targetActorId}/rpc/req`
    mqttPublish(topic, toBinary(RpcRequestSchema, req), false).catch((err) => {
      clearTimeout(timer)
      pending.delete(requestId)
      reject(err instanceof Error ? err : new Error(String(err)))
    })
  })
}

function addWorkspaceResponseError(response: RpcResponse): Error | null {
  if (!response.success) {
    return new Error(response.error || 'addWorkspace rejected')
  }
  if (response.result.case !== 'addWorkspaceResult') {
    return new Error(`unexpected result variant: ${response.result.case}`)
  }
  if (!response.result.value.accepted) {
    return new Error(response.result.value.error || response.error || 'addWorkspace rejected')
  }
  return null
}

function fetchWorkspacesResponseError(response: RpcResponse): Error | null {
  if (!response.success) {
    return new Error(response.error || 'fetchWorkspaces rejected')
  }
  if (response.result.case !== 'fetchWorkspacesResult') {
    return new Error(`unexpected result variant: ${response.result.case}`)
  }
  return null
}

// ---------------------------------------------------------------------------
// Public helper: fetchWorkspaces
// ---------------------------------------------------------------------------

export interface FetchWorkspacesArgs {
  targetActorId: string
  timeoutMs?: number
}

export async function fetchWorkspaces(args: FetchWorkspacesArgs): Promise<FetchWorkspacesResult> {
  const response = await sendRequest((req) => {
    req.method = {
      case: 'fetchWorkspaces',
      value: create(FetchWorkspacesRequestSchema, {}),
    }
  }, args.targetActorId, args.timeoutMs)

  const error = fetchWorkspacesResponseError(response)
  if (error) throw error
  return response.result.value as FetchWorkspacesResult
}

// ---------------------------------------------------------------------------
// Public helper: addWorkspace
// ---------------------------------------------------------------------------

export interface AddWorkspaceArgs {
  targetActorId: string
  path: string
  timeoutMs?: number
}

export async function addWorkspace(args: AddWorkspaceArgs): Promise<AddWorkspaceResult> {
  const path = args.path.trim()
  if (!path) {
    throw new Error('addWorkspace: path is required')
  }

  const response = await sendRequest((req) => {
    req.method = {
      case: 'addWorkspace',
      value: create(AddWorkspaceRequestSchema, { path }),
    }
  }, args.targetActorId, args.timeoutMs)

  const error = addWorkspaceResponseError(response)
  if (error) throw error
  return response.result.value as AddWorkspaceResult
}

// ---------------------------------------------------------------------------
// Public helper: runtimeStart
// ---------------------------------------------------------------------------

export interface RuntimeStartArgs {
  targetActorId: string    // daemon actor_id to route the RPC to
  workspaceId: string       // supabase workspace id (or empty for bare spawn)
  worktree: string          // leave empty — target daemon resolves local path from workspaceId
  sessionId: string         // supabase session id
  agentType: number         // amux.AgentType enum (e.g., AgentType.CLAUDE_CODE)
  initialPrompt?: string
  modelId?: string
  timeoutMs?: number
}

export async function runtimeStart(args: RuntimeStartArgs): Promise<RuntimeStartResult> {
  const response = await sendRequest((req) => {
    const start = create(RuntimeStartRequestSchema, {
      workspaceId: args.workspaceId,
      worktree: args.worktree,
      sessionId: args.sessionId,
      agentType: args.agentType,
      initialPrompt: args.initialPrompt ?? '',
      modelId: args.modelId ?? '',
    })
    req.method = { case: 'runtimeStart', value: start }
  }, args.targetActorId, args.timeoutMs)

  if (!response.success) {
    throw new Error(response.error || 'runtimeStart rejected')
  }
  if (response.result.case !== 'runtimeStartResult') {
    throw new Error(`unexpected result variant: ${response.result.case}`)
  }
  return response.result.value
}

// ---------------------------------------------------------------------------
// Public helper: runtimeStop (skeleton for M8)
// ---------------------------------------------------------------------------

export interface RuntimeStopArgs {
  targetActorId: string
  runtimeId: string
  timeoutMs?: number
}

export async function runtimeStop(args: RuntimeStopArgs): Promise<RuntimeStopResult> {
  const response = await sendRequest((req) => {
    const stop = create(RuntimeStopRequestSchema, { runtimeId: args.runtimeId })
    req.method = { case: 'runtimeStop', value: stop }
  }, args.targetActorId, args.timeoutMs)

  if (!response.success) {
    throw new Error(response.error || 'runtimeStop rejected')
  }
  if (response.result.case !== 'runtimeStopResult') {
    throw new Error(`unexpected result variant: ${response.result.case}`)
  }
  return response.result.value
}

// ---------------------------------------------------------------------------
// Public helper: setModel
// ---------------------------------------------------------------------------

export interface SetModelArgs {
  targetActorId: string
  runtimeId: string
  modelId: string
  timeoutMs?: number
}

export async function setModel(args: SetModelArgs): Promise<SetModelResult> {
  const response = await sendRequest((req) => {
    const sm = create(SetModelRequestSchema, {
      runtimeId: args.runtimeId,
      modelId: args.modelId,
    })
    req.method = { case: 'setModel', value: sm }
  }, args.targetActorId, args.timeoutMs)

  if (!response.success) {
    throw new Error(response.error || 'setModel rejected')
  }
  if (response.result.case !== 'setModelResult') {
    throw new Error(`unexpected result variant: ${response.result.case}`)
  }
  const result = response.result.value
  if (!result.success) {
    throw new Error(result.error || 'setModel failed')
  }
  return result
}
