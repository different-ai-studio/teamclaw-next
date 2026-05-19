// services/fc/test/push-dispatch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchPush } from '../lib/push-dispatch.mjs';

function makeDeps({ recipients, claim = true }) {
  const sent = [];
  const revoked = [];
  return {
    sent, revoked,
    sb: {
      rpc(name, args) {
        if (name === 'push_idempotency_claim') {
          return Promise.resolve({ data: [{ claimed: claim }] });
        }
        if (name === 'list_session_push_targets') {
          return Promise.resolve({
            data: { sender_display_name: 'Alice', recipients },
          });
        }
        throw new Error(`unexpected rpc ${name}`);
      },
      revokeToken: (t) => { revoked.push(t); },
    },
    apns: {
      send: async (token, payload) => {
        sent.push({ token, payload });
        return token.startsWith('BAD') ? { status: 410, reason: 'Unregistered' }
                                       : { status: 200 };
      },
    },
    now: () => new Date('2026-05-17T03:00:00Z'),
  };
}

test('skips duplicate via idempotency', async () => {
  const d = makeDeps({ recipients: [], claim: false });
  const r = await dispatchPush({ id: 'm1', session_id: 's', sender_actor_id: 'a',
                                  kind: 'text', content: 'hi' }, d);
  assert.equal(r.skipped, 'duplicate');
  assert.equal(d.sent.length, 0);
});

test('skips system kind without idempotency claim', async () => {
  const d = makeDeps({ recipients: [] });
  const r = await dispatchPush({ id: 'm1', session_id: 's', sender_actor_id: 'a',
                                  kind: 'system', content: '' }, d);
  assert.equal(r.skipped, 'system_kind');
});

test('drops muted recipient', async () => {
  const d = makeDeps({ recipients: [{
    user_id: 'u1', muted: true, prefs: { enabled: true },
    tokens: [{ provider: 'apns', token: 'GOOD1', device_id: 'D1' }],
    presence: [],
  }] });
  await dispatchPush({ id: 'm1', session_id: 's', sender_actor_id: 'a',
                       kind: 'text', content: 'hi' }, d);
  assert.equal(d.sent.length, 0);
});

test('drops foreground device', async () => {
  const d = makeDeps({ recipients: [{
    user_id: 'u1', muted: false, prefs: { enabled: true },
    tokens: [{ provider: 'apns', token: 'GOOD1', device_id: 'D1' }],
    presence: [{ device_id: 'D1', foreground_until: '2099-01-01T00:00:00Z' }],
  }] });
  await dispatchPush({ id: 'm1', session_id: 's', sender_actor_id: 'a',
                       kind: 'text', content: 'hi' }, d);
  assert.equal(d.sent.length, 0);
});

test('sends to active token and revokes 410', async () => {
  const d = makeDeps({ recipients: [{
    user_id: 'u1', muted: false, prefs: { enabled: true },
    tokens: [
      { provider: 'apns', token: 'GOOD1', device_id: 'D1' },
      { provider: 'apns', token: 'BAD2',  device_id: 'D2' },
    ],
    presence: [],
  }] });
  const r = await dispatchPush({ id: 'm1', session_id: 's', sender_actor_id: 'a',
                                  kind: 'text', content: 'hi' }, d);
  assert.equal(d.sent.length, 2);
  assert.deepEqual(d.revoked, ['BAD2']);
  assert.equal(r.sent, 1);
  assert.equal(r.revoked, 1);
});
