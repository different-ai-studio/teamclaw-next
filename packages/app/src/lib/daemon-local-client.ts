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
  let info: DaemonHttpInfo | null = null
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
      body: JSON.stringify({ scopes: ['workspace:read', 'workspace:write'], ttl_secs: 3600 }),
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

// ─── Authenticated fetch ──────────────────────────────────────────────────────

async function daemonFetch<T>(
  path: string,
  init?: RequestInit,
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

export async function putDaemonProviderAuth(
  workspaceId: string,
  providerId: string,
  req: DaemonProviderAuthRequest,
): Promise<DaemonApplyOutcome | null> {
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/providers/${encodeURIComponent(providerId)}/auth`,
    { method: 'POST', body: JSON.stringify(req) },
  )
  return result.ok ? result.data.outcome : null
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
 * Fetch the workspace permission map.
 * Returns a flat `{ bash: 'ask', read: 'allow', ... }` object, stripping the
 * `skills` wrapper the daemon uses internally.
 */
export async function getDaemonPermissions(
  workspaceId: string,
): Promise<DaemonPermissionMap | null> {
  const result = await daemonFetch<{ skills: DaemonPermissionMap }>(
    `/v1/workspaces/${workspaceId}/permissions`,
  )
  return result.ok ? (result.data.skills ?? {}) : null
}

/**
 * Replace the workspace permission map.
 * Accepts the flat `{ bash: 'ask', ... }` shape; wraps it in `{ skills: ... }`
 * before sending to the daemon.
 */
export async function putDaemonPermissions(
  workspaceId: string,
  permissions: DaemonPermissionMap,
): Promise<DaemonApplyOutcome | null> {
  const result = await daemonFetch<{ outcome: DaemonApplyOutcome }>(
    `/v1/workspaces/${workspaceId}/permissions`,
    { method: 'PUT', body: JSON.stringify({ skills: permissions }) },
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
