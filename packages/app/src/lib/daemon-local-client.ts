/**
 * daemon-local-client.ts
 *
 * Authenticated HTTP client for the daemon's local workspace-control plane.
 * Only works when running inside Tauri (desktop) because it needs to read the
 * daemon port / token files via the `get_daemon_http_info` IPC command.
 *
 * Workspace IDs passed to all API functions are base64url-encoded absolute
 * filesystem paths — use `encodeWorkspaceId(workspacePath)` to build them.
 */

import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/lib/utils'

// ─── Workspace ID encoding ────────────────────────────────────────────────────

/**
 * Encode an absolute workspace path into the base64url workspace-ID accepted
 * by `/v1/workspaces/:id/*` routes.
 *
 * The Rust side decodes this with `base64::URL_SAFE_NO_PAD`, so we use the
 * same alphabet (A-Z a-z 0-9 - _) with no padding.
 */
export function encodeWorkspaceId(workspacePath: string): string {
  const bytes = new TextEncoder().encode(workspacePath)
  let binary = ''
  bytes.forEach((b) => (binary += String.fromCharCode(b)))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

// ─── Connection cache ─────────────────────────────────────────────────────────

interface DaemonHttpInfo {
  base_url: string
  root_token: string
}

interface DaemonConnection {
  baseUrl: string
  sessionToken: string
  /** Expiry time (ms since epoch). Re-exchange when this is in the past. */
  expiresAt: number
}

let _connection: DaemonConnection | null = null
let _inflight: Promise<DaemonConnection | null> | null = null

/** Cached connection; null if daemon HTTP is unavailable. */
async function getConnection(): Promise<DaemonConnection | null> {
  if (!isTauri()) return null

  // Return cached connection if still valid (5 min buffer before expiry).
  if (_connection && Date.now() < _connection.expiresAt - 5 * 60 * 1000) {
    return _connection
  }

  // Coalesce concurrent callers.
  if (_inflight) return _inflight
  _inflight = _fetchConnection().finally(() => {
    _inflight = null
  })
  return _inflight
}

async function _fetchConnection(): Promise<DaemonConnection | null> {
  let info: DaemonHttpInfo | null
  try {
    info = await invoke<DaemonHttpInfo | null>('get_daemon_http_info')
  } catch {
    return null
  }
  if (!info) return null

  // Exchange root token for a scoped session token.
  try {
    const resp = await fetch(`${info.base_url}/v1/auth/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${info.root_token}`,
      },
      body: JSON.stringify({
        scopes: ['workspace:read', 'workspace:write', 'sessions:read', 'sessions:write', 'events:read'],
        ttl_seconds: 3600,
      }),
    })
    if (!resp.ok) {
      console.warn('[daemon-local-client] token exchange failed:', resp.status)
      return null
    }
    const data: { token?: string; expires_in?: number } = await resp.json()
    if (!data.token) return null
    _connection = {
      baseUrl: info.base_url,
      sessionToken: data.token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    }
    return _connection
  } catch (err) {
    console.warn('[daemon-local-client] failed to reach daemon HTTP:', err)
    return null
  }
}

/** Invalidate the cached session token (e.g. after the daemon restarts). */
export function invalidateDaemonConnection(): void {
  _connection = null
}

export type DaemonHttpProbe =
  | { ok: true; baseUrl: string }
  | { ok: false; reason: 'not_tauri' | 'port_file_missing' | 'token_exchange_failed' | 'health_check_failed' | 'ipc_error' }

/** Probe daemon HTTP and return a specific failure reason for UI messaging. */
export async function probeDaemonHttp(): Promise<DaemonHttpProbe> {
  if (!isTauri()) return { ok: false, reason: 'not_tauri' }

  let info: DaemonHttpInfo | null
  try {
    info = await invoke<DaemonHttpInfo | null>('get_daemon_http_info')
  } catch (err) {
    console.warn('[daemon-local-client] get_daemon_http_info failed:', err)
    return { ok: false, reason: 'ipc_error' }
  }
  if (!info) {
    console.warn(
      '[daemon-local-client] ~/.amuxd/amuxd.http.port or amuxd.http.token missing — is amuxd running with HTTP enabled?',
    )
    return { ok: false, reason: 'port_file_missing' }
  }

  invalidateDaemonConnection()
  _connection = null
  const conn = await _fetchConnection()
  if (!conn) return { ok: false, reason: 'token_exchange_failed' }

  try {
    const resp = await fetch(`${conn.baseUrl}/v1/healthz`)
    if (!resp.ok) {
      console.warn('[daemon-local-client] healthz returned', resp.status)
      return { ok: false, reason: 'health_check_failed' }
    }
    return { ok: true, baseUrl: conn.baseUrl }
  } catch (err) {
    console.warn('[daemon-local-client] healthz fetch failed:', err)
    return { ok: false, reason: 'health_check_failed' }
  }
}

/** True when the local daemon HTTP server responds to `/v1/healthz`. */
export async function isDaemonHttpAvailable(): Promise<boolean> {
  const probe = await probeDaemonHttp()
  return probe.ok
}

// ─── Authenticated fetch ──────────────────────────────────────────────────────

async function daemonFetch<T>(
  path: string,
  init?: RequestInit,
  // Internal: set false to disable the single re-auth retry (prevents loops).
  allowReauth = true,
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const conn = await getConnection()
  if (!conn) return { ok: false, status: 0, error: 'daemon HTTP not available' }

  const resp = await fetch(`${conn.baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${conn.sessionToken}`,
      ...(init?.headers ?? {}),
    },
  })

  if (!resp.ok) {
    // A 401 means our cached session token was rejected — most commonly because
    // the daemon restarted and minted a new root token. Drop the stale token,
    // re-exchange, and retry the request exactly once.
    if (resp.status === 401 && allowReauth) {
      invalidateDaemonConnection()
      return daemonFetch<T>(path, init, false)
    }
    const text = await resp.text().catch(() => '')
    return { ok: false, status: resp.status, error: text }
  }

  const data: T = await resp.json()
  return { ok: true, data }
}

// ─── Workspace-control types (mirrors Rust workspace_control.rs) ──────────────

export interface DaemonProviderInfo {
  id: string
  display_name: string
  authenticated: boolean
  base_url?: string
  models: string[]
}

export interface DaemonProviderAuthRequest {
  api_key: string
  base_url?: string
  display_name?: string
  models?: Array<{ model_id: string; model_name?: string }>
}

/** Skill-name → 'allow' | 'deny' | 'ask' */
export type DaemonPermissionMap = Record<string, 'allow' | 'deny' | 'ask'>

export interface DaemonPermissionConfig {
  skills: DaemonPermissionMap
  tools: DaemonPermissionMap
}

export interface DaemonAllowlistRule {
  project_id: string
  permission: string
  pattern: string
  decision: 'allow' | 'deny'
}

export type DaemonApplyOutcome = 'applied_live' | 'reload_required' | 'restart_required'

// ─── Providers ────────────────────────────────────────────────────────────────

export async function getDaemonProviders(
  workspaceId: string,
): Promise<DaemonProviderInfo[] | null> {
  const result = await daemonFetch<DaemonProviderInfo[]>(
    `/v1/workspaces/${workspaceId}/providers`,
  )
  return result.ok ? result.data : null
}

// ─── Provider auth catalog & OAuth (Phase 1 catalog, Phase 2 execution) ─────

export type DaemonProviderAuthMethod = {
  type: 'oauth' | 'api'
  label: string
}

export type DaemonProviderAuthMethods = Record<string, DaemonProviderAuthMethod[]>

export async function getDaemonProviderAuthMethods(
  workspaceId: string,
): Promise<DaemonProviderAuthMethods | null> {
  const result = await daemonFetch<DaemonProviderAuthMethods>(
    `/v1/workspaces/${workspaceId}/provider-auth-methods`,
  )
  return result.ok ? result.data : null
}

export type DaemonOAuthAuthorizeResult =
  | { ok: true; url: string; method: 'auto' | 'code'; instructions: string }
  | { ok: false; status: number; code?: string; message: string }

export type DaemonOAuthCallbackResult =
  | { ok: true; outcome: DaemonApplyOutcome }
  | { ok: false; status: number; code?: string; message: string }

function problemDetailFromErrorBody(error: string): { code?: string; detail: string } {
  try {
    const parsed = JSON.parse(error) as { code?: string; detail?: string }
    return {
      code: parsed.code,
      detail: parsed.detail ?? error,
    }
  } catch {
    return { detail: error }
  }
}

export async function postDaemonProviderOAuthAuthorize(
  workspaceId: string,
  providerId: string,
  methodIndex: number,
  inputs?: Record<string, string>,
): Promise<DaemonOAuthAuthorizeResult> {
  const result = await daemonFetch<{
    url: string
    method: string
    instructions: string
  }>(
    `/v1/workspaces/${workspaceId}/providers/${encodeURIComponent(providerId)}/oauth/authorize`,
    {
      method: 'POST',
      body: JSON.stringify({ method_index: methodIndex, inputs: inputs ?? {} }),
    },
  )
  if (result.ok) {
    const method =
      result.data.method === 'auto' || result.data.method === 'code'
        ? result.data.method
        : 'code'
    return {
      ok: true,
      url: result.data.url,
      method,
      instructions: result.data.instructions,
    }
  }
  const problem = problemDetailFromErrorBody(result.error)
  return {
    ok: false,
    status: result.status,
    code: problem.code,
    message: problem.detail,
  }
}

export async function postDaemonProviderOAuthCallback(
  workspaceId: string,
  providerId: string,
  methodIndex: number,
  code?: string,
): Promise<DaemonOAuthCallbackResult> {
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/providers/${encodeURIComponent(providerId)}/oauth/callback`,
    {
      method: 'POST',
      body: JSON.stringify({ method_index: methodIndex, code: code ?? null }),
    },
  )
  if (result.ok) {
    return { ok: true, outcome: result.data.outcome }
  }
  const problem = problemDetailFromErrorBody(result.error)
  return {
    ok: false,
    status: result.status,
    code: problem.code,
    message: problem.detail,
  }
}

/** Mirrors Rust `workspaces::CatalogModel`. `ref` is `"<providerSegment>/<modelId>"`. */
export interface DaemonCatalogModel {
  ref: string
  model_id: string
  display_name: string
}

/** Mirrors Rust `workspaces::BackendCatalog`. `backend` is "opencode" | "claude" | "codex". */
export interface DaemonBackendCatalog {
  backend: string
  label: string
  models: DaemonCatalogModel[]
}

/** Mirrors Rust `workspaces::ModelCatalog`. */
export interface DaemonModelCatalog {
  automation_default_backend: string | null
  backends: DaemonBackendCatalog[]
}

/**
 * `GET /v1/workspaces/:id/model-catalog` — models grouped by the agent backend
 * that would run them (OpenCode, Claude Code, Codex). Source of truth for the
 * cron dialog, replacing the OpenCode-only provider list.
 */
export async function getDaemonModelCatalog(
  workspaceId: string,
): Promise<DaemonModelCatalog | null> {
  const result = await daemonFetch<DaemonModelCatalog>(
    `/v1/workspaces/${workspaceId}/model-catalog`,
  )
  return result.ok ? result.data : null
}

export async function putDaemonProviderAuth(
  workspaceId: string,
  providerId: string,
  req: DaemonProviderAuthRequest,
): Promise<DaemonApplyOutcome> {
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/providers/${encodeURIComponent(providerId)}/auth`,
    { method: 'POST', body: JSON.stringify(req) },
  )
  if (!result.ok) {
    const { detail } = problemDetailFromErrorBody(result.error)
    throw new Error(detail || `Failed to save provider auth (${result.status})`)
  }
  return result.data.outcome
}

export async function deleteDaemonProviderAuth(
  workspaceId: string,
  providerId: string,
): Promise<DaemonApplyOutcome | null> {
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/providers/${encodeURIComponent(providerId)}/auth`,
    { method: 'DELETE' },
  )
  return result.ok ? result.data.outcome : null
}

// ─── Permissions ──────────────────────────────────────────────────────────────

/**
 * Fetch the full workspace permission config (skill + tool defaults).
 */
export async function getDaemonPermissionConfig(
  workspaceId: string,
): Promise<DaemonPermissionConfig | null> {
  const result = await daemonFetch<DaemonPermissionConfig>(
    `/v1/workspaces/${workspaceId}/permissions`,
  )
  if (!result.ok) return null
  return {
    skills: result.data.skills ?? {},
    tools: result.data.tools ?? {},
  }
}

/**
 * Fetch the workspace permission map.
 * Returns a flat `{ bash: 'ask', read: 'allow', ... }` object for skill keys only.
 */
export async function getDaemonPermissions(
  workspaceId: string,
): Promise<DaemonPermissionMap | null> {
  const config = await getDaemonPermissionConfig(workspaceId)
  return config?.skills ?? null
}

/** Tool-level permission defaults (e.g. `bash`, `read`) outside the skill map. */
export async function getDaemonToolPermissions(
  workspaceId: string,
): Promise<DaemonPermissionMap | null> {
  const config = await getDaemonPermissionConfig(workspaceId)
  return config?.tools ?? null
}

/**
 * Replace the workspace skill permission map.
 * Pass `tools` to merge tool-level defaults; omitted/empty tools are left unchanged.
 */
export async function putDaemonPermissions(
  workspaceId: string,
  permissions: DaemonPermissionMap,
  tools?: DaemonPermissionMap,
): Promise<DaemonApplyOutcome | null> {
  const body: DaemonPermissionConfig = { skills: permissions, tools: tools ?? {} }
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/permissions`,
    { method: 'PUT', body: JSON.stringify(body) },
  )
  return result.ok ? result.data.outcome : null
}

/** Merge tool-level permission defaults without replacing skill permissions. */
export async function putDaemonToolPermissions(
  workspaceId: string,
  tools: DaemonPermissionMap,
): Promise<DaemonApplyOutcome | null> {
  return putDaemonPermissions(workspaceId, {}, tools)
}

// ─── Roles & skills ───────────────────────────────────────────────────────────

/** Mirrors `RolesSkillsWorkspaceState` from lib/roles/types.ts (camelCase from daemon). */
export interface DaemonRolesSkillsState {
  roles: Array<{
    slug: string
    name: string
    description: string
    body: string
    role: string
    whenToUse: string
    workingStyle: string
    roleSkills: Array<{ name: string; description: string }>
    filePath: string
    rawMarkdown: string
  }>
  skills: Array<{
    filename: string
    name: string
    invocationName?: string
    content: string
    description: string
    source?: string
    dirPath: string
    linkedRoles: string[]
    isRoleSkill: boolean
  }>
  roleUsageBySkill: Record<string, string[]>
  skillNamesByRole: Record<string, string[]>
  metrics: {
    rolesCount: number
    skillsCount: number
    linkedSkillsCount: number
    unlinkedSkillsCount: number
  }
}

export async function getDaemonRolesSkillsState(
  workspaceId: string,
): Promise<DaemonRolesSkillsState | null> {
  const result = await daemonFetch<DaemonRolesSkillsState>(
    `/v1/workspaces/${workspaceId}/roles-skills`,
  )
  return result.ok ? result.data : null
}

export async function getDaemonSkills(
  workspaceId: string,
): Promise<DaemonRolesSkillsState['skills'] | null> {
  const result = await daemonFetch<DaemonRolesSkillsState['skills']>(
    `/v1/workspaces/${workspaceId}/skills`,
  )
  return result.ok ? result.data : null
}

export async function getDaemonRoles(
  workspaceId: string,
): Promise<DaemonRolesSkillsState['roles'] | null> {
  const result = await daemonFetch<DaemonRolesSkillsState['roles']>(
    `/v1/workspaces/${workspaceId}/roles`,
  )
  return result.ok ? result.data : null
}

export interface DaemonUpsertSkillRequest {
  content: string
  skillName?: string
  installLocation?: 'workspace' | 'global'
  dirPath?: string
  filename?: string
}

export async function putDaemonSkill(
  workspaceId: string,
  slug: string,
  req: DaemonUpsertSkillRequest,
): Promise<DaemonRolesSkillsState['skills'][number] | null> {
  const result = await daemonFetch<DaemonRolesSkillsState['skills'][number]>(
    `/v1/workspaces/${workspaceId}/skills/${encodeURIComponent(slug)}`,
    { method: 'PUT', body: JSON.stringify(req) },
  )
  return result.ok ? result.data : null
}

export async function deleteDaemonSkill(
  workspaceId: string,
  slug: string,
  dirPath?: string,
): Promise<DaemonApplyOutcome | null> {
  const query = dirPath ? `?dirPath=${encodeURIComponent(dirPath)}` : ''
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/skills/${encodeURIComponent(slug)}${query}`,
    { method: 'DELETE' },
  )
  return result.ok ? result.data.outcome : null
}

export interface DaemonUpsertRoleRequest {
  rawMarkdown: string
  targetFilePath?: string
}

export async function putDaemonRole(
  workspaceId: string,
  slug: string,
  req: DaemonUpsertRoleRequest,
): Promise<DaemonRolesSkillsState['roles'][number] | null> {
  const result = await daemonFetch<DaemonRolesSkillsState['roles'][number]>(
    `/v1/workspaces/${workspaceId}/roles/${encodeURIComponent(slug)}`,
    { method: 'PUT', body: JSON.stringify(req) },
  )
  return result.ok ? result.data : null
}

export async function deleteDaemonRole(
  workspaceId: string,
  slug: string,
  filePath?: string,
): Promise<DaemonApplyOutcome | null> {
  const query = filePath ? `?filePath=${encodeURIComponent(filePath)}` : ''
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/roles/${encodeURIComponent(slug)}${query}`,
    { method: 'DELETE' },
  )
  return result.ok ? result.data.outcome : null
}

// ─── Allowlist ────────────────────────────────────────────────────────────────

export async function getDaemonAllowlist(
  workspaceId: string,
): Promise<DaemonAllowlistRule[] | null> {
  const result = await daemonFetch<DaemonAllowlistRule[]>(
    `/v1/workspaces/${workspaceId}/permission-allowlist`,
  )
  return result.ok ? result.data : null
}

export async function putDaemonAllowlist(
  workspaceId: string,
  rules: DaemonAllowlistRule[],
): Promise<DaemonApplyOutcome | null> {
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/permission-allowlist`,
    { method: 'PUT', body: JSON.stringify(rules) },
  )
  return result.ok ? result.data.outcome : null
}

// ─── MCP ──────────────────────────────────────────────────────────────────────

/** Single MCP server config entry; mirrors `McpServerConfig` in workspace_control.rs. */
export interface DaemonMcpServerConfig {
  /** `"local"` (stdio) or `"remote"` (HTTP). May be absent for legacy entries. */
  type?: string
  enabled?: boolean
  /** Command + args for local stdio servers. */
  command?: string[]
  environment?: Record<string, string>
  /** Base URL for remote HTTP servers. */
  url?: string
  headers?: Record<string, string>
  timeout?: number
  [key: string]: unknown
}

export async function getDaemonMcp(
  workspaceId: string,
): Promise<Record<string, DaemonMcpServerConfig> | null> {
  const result = await daemonFetch<Record<string, DaemonMcpServerConfig>>(
    `/v1/workspaces/${workspaceId}/mcp`,
  )
  return result.ok ? result.data : null
}

export async function putDaemonMcp(
  workspaceId: string,
  servers: Record<string, DaemonMcpServerConfig>,
): Promise<DaemonApplyOutcome | null> {
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/mcp`,
    { method: 'PUT', body: JSON.stringify(servers) },
  )
  return result.ok ? result.data.outcome : null
}

// ─── Runtime ──────────────────────────────────────────────────────────────────

export async function reloadDaemonRuntime(
  workspaceId: string,
): Promise<DaemonApplyOutcome | null> {
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/runtime/reload`,
    { method: 'POST' },
  )
  return result.ok ? result.data.outcome : null
}

// ─── Team share ───────────────────────────────────────────────────────────────

export interface DaemonTeamLinkResult {
  team_id: string
  /** `symlink` | `junction` | `fallback` | `legacy_retained` */
  status: 'symlink' | 'junction' | 'fallback' | 'legacy_retained'
  /** `~/.amuxd/teams/<team_id>/teamclaw-team` */
  global_dir: string
}

/**
 * Ask the local daemon to materialize the team's global dir + this workspace's
 * `teamclaw-team` symlink *now* — called right after enabling/joining
 * team-share so the synced directory exists immediately instead of waiting for
 * the daemon's next start or the first runtime (the AddWorkspace path rides
 * MQTT, which may not be connected right after onboarding).
 *
 * Best-effort: returns `null` when the daemon HTTP is unavailable or the call
 * fails (e.g. the daemon isn't onboarded to a team). The link is still created
 * lazily later, so a failure here is non-fatal to enabling team-share.
 */
export async function linkDaemonTeamWorkspace(
  workspacePath: string,
): Promise<DaemonTeamLinkResult | null> {
  const path = workspacePath.trim()
  if (!path) return null
  try {
    const result = await daemonFetch<DaemonTeamLinkResult>('/v1/team/link', {
      method: 'POST',
      body: JSON.stringify({ path }),
    })
    if (!result.ok) {
      console.warn('[daemon-local-client] team link failed:', result.error)
      return null
    }
    return result.data
  } catch (err) {
    // Network/IPC errors (daemon not running, no HTTP) are expected and
    // non-fatal — the link is created lazily on the daemon's next start.
    console.warn('[daemon-local-client] team link unavailable:', err)
    return null
  }
}
