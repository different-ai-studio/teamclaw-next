// services/fc/test/sync-auth.test.mjs
// Unit tests for sync-auth.mjs logic. sync-auth now verifies the bearer token
// through supabase.auth.getUser(token) (no local SUPABASE_JWT_SECRET), so the
// injectable re-implementation below mirrors that: a mock supabase client with
// auth.getUser + rpc. (ESM module mocking is awkward, so we test the same logic
// via a thin injectable copy, as before.)

import { test } from 'node:test';
import assert from 'node:assert/strict';

async function authenticateSyncCallTestable({ headers, teamId }, supabase) {
  const authz = headers?.authorization || headers?.Authorization;
  if (!authz?.startsWith('Bearer ')) return { ok: false, status: 401, error: 'missing bearer token' };
  const token = authz.slice(7);

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user?.id) {
    return { ok: false, status: 401, error: `jwt invalid: ${userErr?.message ?? 'no user'}` };
  }
  const userId = userData.user.id;

  const { data: rows, error } = await supabase.rpc('actor_id_for_user_in_team', {
    p_user_id: userId, p_team_id: teamId,
  });
  if (error) return { ok: false, status: 403, error: `actor lookup failed: ${error.message}` };
  if (!rows || rows.length === 0 || rows[0] == null) {
    return { ok: false, status: 403, error: 'caller is not a member of this team' };
  }
  const actorId = typeof rows[0] === 'object' ? Object.values(rows[0])[0] : rows[0];
  if (!actorId) return { ok: false, status: 403, error: 'caller has no actor in this team' };
  return { ok: true, userId, teamId, actorId };
}

// Mock supabase client builders -------------------------------------------------
function sbWithUser(userId, rpcImpl) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) },
    rpc: rpcImpl ?? (async () => ({ data: [], error: null })),
  };
}
function sbInvalidToken() {
  return {
    auth: { getUser: async () => ({ data: { user: null }, error: { message: 'invalid JWT' } }) },
    rpc: async () => ({ data: [], error: null }),
  };
}

// 401: missing / bad token ------------------------------------------------------
test('401 when no Authorization header', async () => {
  const r = await authenticateSyncCallTestable({ headers: {}, teamId: 'tid' }, sbInvalidToken());
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.match(r.error, /missing/i);
});

test('401 when Authorization is not Bearer', async () => {
  const r = await authenticateSyncCallTestable(
    { headers: { authorization: 'Basic abc123' }, teamId: 'tid' },
    sbInvalidToken(),
  );
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

test('401 when Supabase rejects the token', async () => {
  const r = await authenticateSyncCallTestable(
    { headers: { authorization: 'Bearer bad.token.here' }, teamId: 'tid' },
    sbInvalidToken(),
  );
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.match(r.error, /jwt invalid/i);
});

// 403: RPC error / not a member ------------------------------------------------
test('403 when supabase RPC returns error', async () => {
  const sb = sbWithUser('user1', async () => ({ data: null, error: { message: 'db is down' } }));
  const r = await authenticateSyncCallTestable(
    { headers: { authorization: 'Bearer t' }, teamId: 'tid' },
    sb,
  );
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.match(r.error, /actor lookup failed/i);
});

test('403 when RPC returns empty rows (not a member)', async () => {
  const sb = sbWithUser('user1', async () => ({ data: [], error: null }));
  const r = await authenticateSyncCallTestable(
    { headers: { authorization: 'Bearer t' }, teamId: 'tid' },
    sb,
  );
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.match(r.error, /not a member/i);
});

test('403 when RPC returns null actor_id', async () => {
  const sb = sbWithUser('user1', async () => ({ data: [null], error: null }));
  const r = await authenticateSyncCallTestable(
    { headers: { authorization: 'Bearer t' }, teamId: 'tid' },
    sb,
  );
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

// 200: success path ------------------------------------------------------------
test('ok when token is valid and actor exists', async () => {
  const sb = sbWithUser('user-uuid-123', async (name, args) => {
    assert.equal(name, 'actor_id_for_user_in_team');
    assert.equal(args.p_user_id, 'user-uuid-123');
    assert.equal(args.p_team_id, 'team-uuid-456');
    return { data: ['actor-uuid-789'], error: null };
  });
  const r = await authenticateSyncCallTestable(
    { headers: { authorization: 'Bearer t' }, teamId: 'team-uuid-456' },
    sb,
  );
  assert.equal(r.ok, true);
  assert.equal(r.userId, 'user-uuid-123');
  assert.equal(r.teamId, 'team-uuid-456');
  assert.equal(r.actorId, 'actor-uuid-789');
});

test('ok with object-shaped row from RPC', async () => {
  const sb = sbWithUser('user-uuid-123', async () => ({
    data: [{ actor_id_for_user_in_team: 'actor-uuid-789' }],
    error: null,
  }));
  const r = await authenticateSyncCallTestable(
    { headers: { authorization: 'Bearer t' }, teamId: 'team-uuid-456' },
    sb,
  );
  assert.equal(r.ok, true);
  assert.equal(r.actorId, 'actor-uuid-789');
});
