import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSupabaseBusinessRepository,
  createSupabaseAuthRepository,
  publishableKeyFromEnv,
} from "../lib/supabase-repo.mjs";

test("createSupabaseBusinessRepository creates caller-scoped Supabase client", async () => {
  const calls = [];
  const repo = createSupabaseBusinessRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    accessToken: "caller-token",
    createClient(url, key, options) {
      calls.push({ url, key, options });
      return fakeSupabase();
    },
  });

  await repo.listSessions({ limit: 25 });

  assert.deepEqual(calls, [{
    url: "https://example.supabase.co",
    key: "publishable-key",
    options: {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: "Bearer caller-token" } },
    },
  }]);
});

test("publishableKeyFromEnv prefers publishable key and falls back to anon key", () => {
  assert.equal(publishableKeyFromEnv({ SUPABASE_PUBLISHABLE_KEY: "pk", SUPABASE_ANON_KEY: "anon" }), "pk");
  assert.equal(publishableKeyFromEnv({ SUPABASE_ANON_KEY: "anon" }), "anon");
});

test("listSessions maps current actor session rpc rows", async () => {
  const rpcCalls = [];
  const repo = createRepo(fakeSupabase({
    rpcCalls,
    rpcData: {
      list_current_actor_sessions: [{
        id: "session-1",
        team_id: "team-1",
        title: "Plan",
        mode: "collab",
        idea_id: "idea-1",
        last_message_at: "2026-05-27T01:00:00Z",
        last_message_preview: "hello",
        has_unread: true,
        created_at: "2026-05-26T01:00:00Z",
        updated_at: "2026-05-27T01:00:00Z",
      }],
    },
  }));

  const rows = await repo.listSessions({
    limit: 10,
    cursor: { lastMessageAt: "2026-05-27T00:00:00Z", createdAt: "2026-05-26T00:00:00Z", id: "s0" },
  });

  assert.deepEqual(rpcCalls, [{
    name: "list_current_actor_sessions",
    args: {
      p_limit: 10,
      p_before_last_message_at: "2026-05-27T00:00:00Z",
      p_before_created_at: "2026-05-26T00:00:00Z",
      p_before_id: "s0",
    },
  }]);
  assert.deepEqual(rows, [{
    id: "session-1",
    teamId: "team-1",
    title: "Plan",
    mode: "collab",
    ideaId: "idea-1",
    lastMessageAt: "2026-05-27T01:00:00Z",
    lastMessagePreview: "hello",
    hasUnread: true,
    createdAt: "2026-05-26T01:00:00Z",
    updatedAt: "2026-05-27T01:00:00Z",
  }]);
});

test("insertMessage writes a messages row and maps response", async () => {
  const tableCalls = [];
  const repo = createRepo(fakeSupabase({
    tableCalls,
    tableData: {
      messages: [{
        id: "message-1",
        team_id: "team-1",
        session_id: "session-1",
        turn_id: null,
        sender_actor_id: "actor-1",
        reply_to_message_id: null,
        kind: "text",
        content: "hello",
        metadata: null,
        model: null,
        created_at: "2026-05-27T01:00:00Z",
        updated_at: null,
      }],
    },
  }));

  const message = await repo.insertMessage("session-1", {
    id: "message-1",
    teamId: "team-1",
    senderActorId: "actor-1",
    content: "hello",
  });

  assert.equal(tableCalls[0].table, "messages");
  assert.equal(tableCalls[0].op, "insert");
  assert.deepEqual(tableCalls[0].row, {
    id: "message-1",
    team_id: "team-1",
    session_id: "session-1",
    sender_actor_id: "actor-1",
    kind: "text",
    content: "hello",
    metadata: null,
    model: null,
    turn_id: null,
    reply_to_message_id: null,
  });
  assert.equal(message.id, "message-1");
  assert.equal(message.teamId, "team-1");
  assert.equal(message.senderActorId, "actor-1");
});

test("auth repo claimInvite calls claim_team_invite RPC anonymously", async () => {
  // The bootstrap claim flow has no caller bearer; the auth repo must use an
  // anon-key Supabase client (no Authorization header) to invoke the
  // SECURITY DEFINER RPC `claim_team_invite`.
  const createCalls = [];
  const repo = createSupabaseAuthRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    createClient(url, key, options) {
      createCalls.push({ url, key, options });
      return fakeSupabase({
        rpcData: {
          claim_team_invite: [{
            actor_id: "actor-1",
            team_id: "team-1",
            actor_type: "agent",
            display_name: "Daemon",
            refresh_token: "refresh-1",
          }],
        },
      });
    },
  });

  assert.deepEqual(await repo.claimInvite("invite-token"), {
    actorId: "actor-1",
    teamId: "team-1",
    actorType: "agent",
    displayName: "Daemon",
    refreshToken: "refresh-1",
  });
  // Auth repo must NOT attach a caller bearer header.
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].options.global, undefined);
});

test("repository throws upstream errors without hiding Supabase error codes", async () => {
  const repo = createRepo(fakeSupabase({
    rpcErrors: {
      list_current_actor_sessions: { code: "42501", message: "rls denied" },
    },
  }));

  await assert.rejects(() => repo.listSessions(), (err) => {
    assert.equal(err.code, "42501");
    return true;
  });
});

test("createSupabaseAuthRepository refreshAccessToken calls Supabase auth endpoint", async () => {
  const fetchCalls = [];
  const repo = createSupabaseAuthRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "anon-key",
    async fetchImpl(url, options) {
      fetchCalls.push({ url, options });
      return new Response(JSON.stringify({
        access_token: "new-at",
        refresh_token: "new-rt",
        expires_at: 1234567890,
      }), { status: 200 });
    },
  });

  const result = await repo.refreshAccessToken({ refreshToken: "old-rt" });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "https://example.supabase.co/auth/v1/token?grant_type=refresh_token");
  assert.equal(fetchCalls[0].options.method, "POST");
  assert.equal(fetchCalls[0].options.headers.apikey, "anon-key");
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), { refresh_token: "old-rt" });
  assert.deepEqual(result, { accessToken: "new-at", refreshToken: "new-rt", expiresAt: 1234567890 });
});

test("createSupabaseAuthRepository refreshAccessToken throws on auth failure", async () => {
  const repo = createSupabaseAuthRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "anon-key",
    async fetchImpl() {
      return new Response("Invalid refresh token", { status: 401 });
    },
  });

  await assert.rejects(
    () => repo.refreshAccessToken({ refreshToken: "bad-rt" }),
    (err) => {
      assert.equal(err.statusCode, 401);
      assert.equal(err.code, "missing_auth");
      return true;
    },
  );
});

function createRepo(supabase) {
  return createSupabaseBusinessRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    accessToken: "caller-token",
    createClient: () => supabase,
  });
}

function fakeSupabase({
  rpcCalls = [],
  tableCalls = [],
  rpcData = {},
  rpcErrors = {},
  tableData = {},
  tableErrors = {},
} = {}) {
  return {
    async rpc(name, args) {
      rpcCalls.push({ name, args });
      return { data: rpcData[name] ?? [], error: rpcErrors[name] ?? null };
    },
    from(table) {
      return createTableQuery(table, tableCalls, tableData[table] ?? [], tableErrors[table] ?? null);
    },
  };
}

function createTableQuery(table, calls, data, error) {
  return {
    select(columns) {
      calls.push({ table, op: "select", columns });
      return createSelectableQuery(table, calls, data, error);
    },
    insert(row) {
      calls.push({ table, op: "insert", row });
      return {
        select(columns) {
          calls.push({ table, op: "insert.select", columns });
          return {
            async single() {
              calls.push({ table, op: "insert.single" });
              return { data: data[0] ?? null, error };
            },
          };
        },
      };
    },
  };
}

function createSelectableQuery(table, calls, data, error) {
  const query = {
    order(column, options) {
      calls.push({ table, op: "order", column, options });
      return query;
    },
    limit(count) {
      calls.push({ table, op: "limit", count });
      return Promise.resolve({ data, error });
    },
    eq(column, value) {
      calls.push({ table, op: "eq", column, value });
      return query;
    },
    single() {
      calls.push({ table, op: "single" });
      return Promise.resolve({ data: data[0] ?? null, error });
    },
    then(resolve, reject) {
      return Promise.resolve({ data, error }).then(resolve, reject);
    },
  };
  return query;
}
