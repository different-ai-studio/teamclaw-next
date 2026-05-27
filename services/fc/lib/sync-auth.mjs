// services/fc/lib/sync-auth.mjs
//
// JWT verification + actor resolution for /sync/* endpoints.
// Spec §3 auth middleware.

import { jwtVerify } from 'jose';
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

  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (!jwtSecret) {
    return { ok: false, status: 500, error: 'SUPABASE_JWT_SECRET not configured' };
  }

  const secret = new TextEncoder().encode(jwtSecret);
  let claims;
  try {
    ({ payload: claims } = await jwtVerify(token, secret, { algorithms: ['HS256'] }));
  } catch (e) {
    return { ok: false, status: 401, error: `jwt invalid: ${e.message}` };
  }

  const userId = claims.sub;
  if (!userId) {
    return { ok: false, status: 401, error: 'jwt has no sub claim' };
  }

  const supabase = createServiceRoleClient();
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

  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (!jwtSecret) {
    return { ok: false, status: 500, error: 'SUPABASE_JWT_SECRET not configured' };
  }

  const secret = new TextEncoder().encode(jwtSecret);
  let claims;
  try {
    ({ payload: claims } = await jwtVerify(token, secret, { algorithms: ['HS256'] }));
  } catch (e) {
    return { ok: false, status: 401, error: `jwt invalid: ${e.message}` };
  }

  const userId = claims.sub;
  if (!userId) {
    return { ok: false, status: 401, error: 'jwt has no sub claim' };
  }

  return { ok: true, userId };
}
