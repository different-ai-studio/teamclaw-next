import { supabase } from '@/lib/supabase-client'

// `create_team_invite` RPC returns deeplinks with the `amux://` scheme (shared
// with iOS). The desktop app accepts both `amux://` and `teamclaw://` so users
// can paste either, and rewrites to `teamclaw://` for display.
const INVITE_SCHEMES = new Set(['teamclaw:', 'amux:'])
const INVITE_HOST = 'invite'

export function parseInviteDeeplink(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (!INVITE_SCHEMES.has(url.protocol)) return null
    if (url.hostname !== INVITE_HOST && url.pathname !== `//${INVITE_HOST}`) return null
    const token = url.searchParams.get('token')
    return token && token.length > 0 ? token : null
  } catch {
    return null
  }
}

export function rewriteAsTeamclawDeeplink(raw: string): string {
  return raw.replace(/^amux:/, 'teamclaw:')
}

export interface ClaimResult {
  actorId: string
  teamId: string
  actorType: string
  displayName: string
  refreshToken: string | null
}

export async function claimInviteToken(token: string): Promise<ClaimResult> {
  const { data, error } = await supabase.rpc('claim_team_invite', { p_token: token })
  if (error) throw new Error(`claim_team_invite failed: ${error.message}`)
  const row = Array.isArray(data) ? data[0] : data
  if (!row) throw new Error('claim_team_invite returned empty result')
  return {
    actorId:      row.actor_id,
    teamId:       row.team_id,
    actorType:    row.actor_type,
    displayName:  row.display_name,
    refreshToken: row.refresh_token ?? null,
  }
}
