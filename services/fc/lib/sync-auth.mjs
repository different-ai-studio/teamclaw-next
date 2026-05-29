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
  if (rows == null || (Array.isArray(rows) && rows.length === 0)) {
    return { ok: false, status: 403, error: 'caller is not a member of this team' };
  }

  // actor_id_for_user_in_team `returns uuid` (a scalar), so supabase-js returns
  // the uuid STRING directly in `data` — NOT wrapped in an array/object. The
  // old `rows[0]` indexed the first CHARACTER of that string (e.g. "f"), which
  // then got inserted into a uuid column and failed upload-prepare with
  // "invalid input syntax for type uuid". Normalize all possible shapes.
  let actorId = null;
  if (typeof rows === 'string') {
    actorId = rows;
  } else if (Array.isArray(rows)) {
    const first = rows[0];
    actorId = first && typeof first === 'object' ? Object.values(first)[0] : first;
  } else if (typeof rows === 'object') {
    actorId = Object.values(rows)[0];
  }
  if (!actorId || typeof actorId !== 'string') {
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
