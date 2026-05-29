// services/fc/lib/sync-auth.mjs
//
// JWT verification + actor resolution for /sync/* endpoints.
// Spec §3 auth middleware.

import { createServiceRoleClient } from './supabase.mjs';

/**
 * Verify the Supabase Bearer JWT and resolve the caller's actor_id for the
 * given team.
 *
 * Returns:
 *   { ok: true,  userId, teamId, actorId }
 *   { ok: false, status: 401|403, error: string }
 *
 * @param {{ headers: Record<string,string>, teamId: string }} opts
 */
export async function authenticateSyncCall({ headers, teamId }) {
  const authz = headers?.authorization || headers?.Authorization;
  if (!authz?.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'missing bearer token' };
  }
  const token = authz.slice(7);

  // Verify the token through Supabase Auth (works for HS256 and asymmetric
  // signing keys alike) instead of a local HS256 check. This matches how the
  // /v1 business API authenticates and removes the SUPABASE_JWT_SECRET env
  // dependency that was never provisioned on FC.
  const supabase = createServiceRoleClient();
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user?.id) {
    return { ok: false, status: 401, error: `jwt invalid: ${userErr?.message ?? 'no user'}` };
  }
  const userId = userData.user.id;

  const { data: rows, error } = await supabase
    .rpc('actor_id_for_user_in_team', { p_user_id: userId, p_team_id: teamId });

  if (error) {
    return { ok: false, status: 403, error: `actor lookup failed: ${error.message}` };
  }
  if (!rows || rows.length === 0 || rows[0] == null) {
    return { ok: false, status: 403, error: 'caller is not a member of this team' };
  }

  // The RPC returns a single uuid scalar (wrapped in an array by supabase-js)
  const actorId = typeof rows[0] === 'object' ? Object.values(rows[0])[0] : rows[0];
  if (!actorId) {
    return { ok: false, status: 403, error: 'caller has no actor in this team' };
  }

  return { ok: true, userId, teamId, actorId };
}

/**
 * Verify the Bearer JWT without checking team membership.
 * Used for /sync/create-team where the team does not exist yet.
 *
 * Returns:
 *   { ok: true,  userId }
 *   { ok: false, status: 401, error: string }
 *
 * @param {{ headers: Record<string,string> }} opts
 */
export async function authenticateJwtOnly({ headers }) {
  const authz = headers?.authorization || headers?.Authorization;
  if (!authz?.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'missing bearer token' };
  }
  const token = authz.slice(7);

  // Verify via Supabase Auth (see authenticateSyncCall) — no local JWT secret.
  const supabase = createServiceRoleClient();
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user?.id) {
    return { ok: false, status: 401, error: `jwt invalid: ${userErr?.message ?? 'no user'}` };
  }

  return { ok: true, userId: userData.user.id };
}
