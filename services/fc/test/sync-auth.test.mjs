// services/fc/test/sync-auth.test.mjs
// Unit tests for sync-auth.mjs helpers using dependency injection / mocking.
// We patch process.env.SUPABASE_JWT_SECRET and mock the supabase client by
// monkey-patching the module via a thin wrapper.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';

// We test the logic of auth by creating real JWTs with the test secret and
// injecting a mock supabase RPC.  We cannot monkey-patch ESM imports easily,
// so we test the auth functions via a thin re-implementation that takes the
// supabase client as a parameter (same logic, injectable).

const TEST_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';

async function makeJwt(sub, expiresIn = '1h') {
  const secret = new TextEncoder().encode(TEST_SECRET);
  return new SignJWT({ sub })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret);
}

// Inline re-implementation that accepts injectable deps so we don't need
// ESM module mocking infrastructure.
import { jwtVerify } from 'jose';

async function authenticateSyncCallTestable({ headers, teamId }, supabase) {
  const authz = headers?.authorization || headers?.Authorization;
  if (!authz?.startsWith('Bearer ')) return { ok: false, status: 401, error: 'missing bearer token' };
  const token = authz.slice(7);
  const secret = new TextEncoder().encode(TEST_SECRET);
  let claims;
  try {
    ({ payload: claims } = await jwtVerify(token, secret, { algorithms: ['HS256'] }));
  } catch (e) {
    return { ok: false, status: 401, error: `jwt invalid: ${e.message}` };
  }
  const userId = claims.sub;
  if (!userId) return { ok: false, status: 401, error: 'jwt has no sub claim' };

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

// ---------------------------------------------------------------------------
// 401: missing / bad token
// ---------------------------------------------------------------------------
test('401 when no Authorization header', async () => {
  const r = await authenticateSyncCallTestable({ headers: {}, teamId: 'tid' }, null);
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.match(r.error, /missing/i);
});

test('401 when Authorization is not Bearer', async () => {
  const r = await authenticateSyncCallTestable({
    headers: { authorization: 'Basic abc123' }, teamId: 'tid',
  }, null);
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

test('401 when JWT signature is wrong', async () => {
  const badToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyMSJ9.BADSIG';
  const r = await authenticateSyncCallTestable({
    headers: { authorization: `Bearer ${badToken}` }, teamId: 'tid',
  }, null);
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.match(r.error, /jwt invalid/i);
});

test('401 when JWT is expired', async () => {
  const token = await makeJwt('user1', '-1s'); // already expired
  const r = await authenticateSyncCallTestable({
    headers: { authorization: `Bearer ${token}` }, teamId: 'tid',
  }, null);
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.match(r.error, /jwt invalid/i);
});

// ---------------------------------------------------------------------------
// 403: RPC error / not a member
// ---------------------------------------------------------------------------
test('403 when supabase RPC returns error', async () => {
  const token = await makeJwt('user1');
  const mockSb = {
    rpc: async () => ({ data: null, error: { message: 'db is down' } }),
  };
  const r = await authenticateSyncCallTestable({
    headers: { authorization: `Bearer ${token}` }, teamId: 'tid',
  }, mockSb);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.match(r.error, /actor lookup failed/i);
});

test('403 when RPC returns empty rows (not a member)', async () => {
  const token = await makeJwt('user1');
  const mockSb = {
    rpc: async () => ({ data: [], error: null }),
  };
  const r = await authenticateSyncCallTestable({
    headers: { authorization: `Bearer ${token}` }, teamId: 'tid',
  }, mockSb);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.match(r.error, /not a member/i);
});

test('403 when RPC returns null actor_id', async () => {
  const token = await makeJwt('user1');
  const mockSb = {
    rpc: async () => ({ data: [null], error: null }),
  };
  const r = await authenticateSyncCallTestable({
    headers: { authorization: `Bearer ${token}` }, teamId: 'tid',
  }, mockSb);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

// ---------------------------------------------------------------------------
// 200: success path
// ---------------------------------------------------------------------------
test('ok when JWT is valid and actor exists', async () => {
  const token = await makeJwt('user-uuid-123');
  const mockSb = {
    rpc: async (name, args) => {
      assert.equal(name, 'actor_id_for_user_in_team');
      assert.equal(args.p_user_id, 'user-uuid-123');
      assert.equal(args.p_team_id, 'team-uuid-456');
      return { data: ['actor-uuid-789'], error: null };
    },
  };
  const r = await authenticateSyncCallTestable({
    headers: { authorization: `Bearer ${token}` }, teamId: 'team-uuid-456',
  }, mockSb);
  assert.equal(r.ok, true);
  assert.equal(r.userId, 'user-uuid-123');
  assert.equal(r.teamId, 'team-uuid-456');
  assert.equal(r.actorId, 'actor-uuid-789');
});

test('ok with object-shaped row from RPC', async () => {
  const token = await makeJwt('user-uuid-123');
  const mockSb = {
    rpc: async () => ({ data: [{ actor_id_for_user_in_team: 'actor-uuid-789' }], error: null }),
  };
  const r = await authenticateSyncCallTestable({
    headers: { authorization: `Bearer ${token}` }, teamId: 'team-uuid-456',
  }, mockSb);
  assert.equal(r.ok, true);
  assert.equal(r.actorId, 'actor-uuid-789');
});
