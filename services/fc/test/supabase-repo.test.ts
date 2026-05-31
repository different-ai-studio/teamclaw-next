import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSupabaseBusinessRepository,
  createSupabaseAuthRepository,
  publishableKeyFromEnv,
} from "../src/lib/supabase-repo.js";

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

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.supabase.co");
  assert.equal(calls[0].key, "publishable-key");
  assert.deepEqual(calls[0].options.auth, { persistSession: false, autoRefreshToken: false });
  assert.deepEqual(calls[0].options.global, { headers: { Authorization: "Bearer caller-token" } });
  // realtime transport is wired so supabase-js doesn't crash on Node 20 (FC runtime);
  // we don't assert on its identity, just that it's set.
  assert.ok(calls[0].options.realtime?.transport, "expected realtime transport to be set");
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

test("auth repo claimInvite forwards the caller bearer for member claims", async () => {
  // Member claims arrive authenticated: the joining user's bearer must reach
  // PostgREST so the RPC resolves auth.uid(). The repo builds a per-token client
  // with an Authorization header instead of using the shared anon client.
  const createCalls = [];
  const repo = createSupabaseAuthRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    createClient(url, key, options) {
      createCalls.push({ url, key, options });
      return fakeSupabase({
        rpcData: {
          claim_team_invite: [{
            actor_id: "actor-9",
            team_id: "team-9",
            actor_type: "member",
            display_name: "Joiner",
            refresh_token: null,
          }],
        },
      });
    },
  });

  assert.deepEqual(await repo.claimInvite("invite-token", { accessToken: "member-jwt" }), {
    actorId: "actor-9",
    teamId: "team-9",
    actorType: "member",
    displayName: "Joiner",
    refreshToken: null,
  });
  // Two clients: the shared anon client at construction, then a per-token
  // authed client carrying the caller bearer.
  assert.equal(createCalls.length, 2);
  assert.equal(createCalls[1].options.global.headers.Authorization, "Bearer member-jwt");
});

test("repository throws upstream errors without hiding Supabase error codes", async () => {
  const repo = createRepo(fakeSupabase({
    rpcErrors: {
      list_current_actor_sessions: { code: "42501", message: "rls denied" },
    },
  }));

  await assert.rejects(() => repo.listSessions(), (err: any) => {
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
    (err: any) => {
      assert.equal(err.statusCode, 401);
      assert.equal(err.code, "missing_auth");
      return true;
    },
  );
});

function createRepo(supabase, extra = {}) {
  return createSupabaseBusinessRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    accessToken: "caller-token",
    createClient: () => supabase,
    ...extra,
  });
}

test("enableShareMode oss calls enable_team_share rpc with null git fields", async () => {
  const rpcCalls = [];
  const repo = createRepo(fakeSupabase({
    rpcCalls,
    rpcData: {
      enable_team_share: [{
        id: "team-1",
        name: "Acme",
        slug: "acme",
        created_at: "2026-05-28T00:00:00Z",
        share_mode: "oss",
        share_enabled_at: "2026-05-28T01:00:00Z",
        git_remote_url: null,
        git_auth_kind: null,
      }],
    },
  }));

  const result = await repo.enableShareMode("team-1", "oss", null);

  assert.deepEqual(rpcCalls[0], {
    name: "enable_team_share",
    args: {
      p_team_id: "team-1",
      p_mode: "oss",
      p_git_remote_url: null,
      p_git_auth_kind: null,
      p_git_credential_ref: null,
    },
  });
  assert.equal(result.id, "team-1");
  assert.equal(result.shareMode, "oss");
  assert.equal(result.shareEnabledAt, "2026-05-28T01:00:00Z");
  assert.equal(result.gitRemoteUrl, null);
});

test("enableShareMode custom_git passes through git config", async () => {
  const rpcCalls = [];
  const repo = createRepo(fakeSupabase({
    rpcCalls,
    rpcData: {
      enable_team_share: [{
        id: "team-2",
        name: "Beta",
        slug: "beta",
        created_at: "2026-05-28T00:00:00Z",
        share_mode: "custom_git",
        share_enabled_at: "2026-05-28T01:00:00Z",
        git_remote_url: "git@example.com:beta/repo.git",
        git_auth_kind: "ssh_key",
      }],
    },
  }));

  const result = await repo.enableShareMode("team-2", "custom_git", {
    remoteUrl: "git@example.com:beta/repo.git",
    authKind: "ssh_key",
    credentialRef: "keychain://team-2/ssh",
  });

  assert.deepEqual(rpcCalls[0].args, {
    p_team_id: "team-2",
    p_mode: "custom_git",
    p_git_remote_url: "git@example.com:beta/repo.git",
    p_git_auth_kind: "ssh_key",
    p_git_credential_ref: "keychain://team-2/ssh",
  });
  assert.equal(result.shareMode, "custom_git");
  assert.equal(result.gitRemoteUrl, "git@example.com:beta/repo.git");
  assert.equal(result.gitAuthKind, "ssh_key");
});

test("getShareMode returns nulls when team row absent", async () => {
  const repo = createRepo(fakeSupabase({ tableData: { teams: [] } }));
  const result = await repo.getShareMode("team-missing");
  assert.deepEqual(result, {
    mode: null,
    enabledAt: null,
    gitRemoteUrl: null,
    gitAuthKind: null,
  });
});

test("getShareMode maps team columns to camelCase", async () => {
  const repo = createRepo(fakeSupabase({
    tableData: {
      teams: [{
        share_mode: "managed_git",
        share_enabled_at: "2026-05-28T03:00:00Z",
        git_remote_url: "https://git.example.com/repo.git",
        git_auth_kind: "https_token",
      }],
    },
  }));
  const result = await repo.getShareMode("team-3");
  assert.deepEqual(result, {
    mode: "managed_git",
    enabledAt: "2026-05-28T03:00:00Z",
    gitRemoteUrl: "https://git.example.com/repo.git",
    gitAuthKind: "https_token",
  });
});

test("setupLiteLlm persists via update_team_litellm RPC", async () => {
  const rpcCalls = [];
  let provisionCalls = 0;
  const repo = createRepo(
    fakeSupabase({
      rpcCalls,
      tableData: {
        teams: [{ id: "team-4", name: "Gamma" }],
      },
    }),
    {
      provisionLiteLlm: async (name) => {
        provisionCalls++;
        assert.equal(name, "Gamma");
        return {
          litellmTeamId: "litellm-team-xyz",
          litellmKey: "sk-litellm-xyz",
          aiGatewayEndpoint: "https://ai.example.com/v1",
        };
      },
    },
  );

  const result = await repo.setupLiteLlm("team-4");

  assert.equal(provisionCalls, 1);
  assert.deepEqual(result, {
    aiGatewayEndpoint: "https://ai.example.com/v1",
    litellmKey: "sk-litellm-xyz",
  });
  const rpc = rpcCalls.find((c) => c.name === "update_team_litellm");
  assert.ok(rpc, "expected update_team_litellm RPC call");
  assert.deepEqual(rpc.args, {
    p_team_id: "team-4",
    p_litellm_team_id: "litellm-team-xyz",
    p_ai_gateway_endpoint: "https://ai.example.com/v1",
  });
});

test("setupLiteLlm throws 503 when provisioner returns null", async () => {
  const repo = createRepo(
    fakeSupabase({ tableData: { teams: [{ id: "team-5", name: "Delta" }] } }),
    { provisionLiteLlm: async () => null },
  );
  await assert.rejects(
    () => repo.setupLiteLlm("team-5"),
    (err: any) => err.code === "litellm_unavailable",
  );
});

test("getWorkspaceConfig merges teams + team_workspace_config rows", async () => {
  const repo = createRepo(fakeSupabase({
    tableData: {
      teams: [{
        share_mode: "custom_git",
        git_remote_url: "https://example.com/repo.git",
        git_auth_kind: "https_token",
      }],
      team_workspace_config: [{
        sync_mode: "git",
        litellm_team_id: "litellm-team-zzz",
      }],
    },
  }));

  const result = await repo.getWorkspaceConfig("team-6");

  assert.deepEqual(result, {
    shareMode: "custom_git",
    gitRemoteUrl: "https://example.com/repo.git",
    gitAuthKind: "https_token",
    syncMode: "git",
    litellmTeamId: "litellm-team-zzz",
  });
});

test("getWorkspaceConfig returns nulls when both rows absent", async () => {
  const repo = createRepo(fakeSupabase({
    tableData: { teams: [], team_workspace_config: [] },
  }));
  const result = await repo.getWorkspaceConfig("team-7");
  assert.deepEqual(result, {
    shareMode: null,
    gitRemoteUrl: null,
    gitAuthKind: null,
    syncMode: null,
    litellmTeamId: null,
  });
});

test("upsertAgentRuntime derives team_id from actor when body omits teamId", async () => {
  const tableCalls = [];
  const repo = createRepo(fakeSupabase({
    tableCalls,
    tableData: {
      actors: [{ team_id: "team-9" }],
      agent_runtimes: [{ id: "rt-1" }],
    },
  }));

  const result = await repo.upsertAgentRuntime({
    // teamId intentionally omitted (the daemon does not send it)
    agentActorId: "agent-1",
    sessionId: "sess-1",
    runtimeId: "rtid-1",
    backendSessionId: "bsid-1",
    backendType: "claude",
    status: "running",
  });

  assert.equal(result.id, "rt-1");
  // Looked up team_id from the actors table under the caller's RLS.
  const actorLookup = tableCalls.find((c) => c.table === "actors" && c.op === "select");
  assert.ok(actorLookup, "expected an actors select for team_id derivation");
  const upsert = tableCalls.find((c) => c.table === "agent_runtimes" && c.op === "upsert");
  assert.ok(upsert, "expected an agent_runtimes upsert");
  assert.equal(upsert.row.team_id, "team-9");
  assert.equal(upsert.row.agent_id, "agent-1");
  assert.deepEqual(upsert.options, { onConflict: "agent_id,backend_session_id" });
});

test("upsertAgentRuntime prefers explicit body.teamId without an actor lookup", async () => {
  const tableCalls = [];
  const repo = createRepo(fakeSupabase({
    tableCalls,
    // No actors row provided; if the code looked it up it would fail to resolve.
    tableData: { agent_runtimes: [{ id: "rt-2" }] },
  }));

  const result = await repo.upsertAgentRuntime({
    teamId: "team-explicit",
    agentActorId: "agent-2",
    sessionId: "sess-2",
    runtimeId: "rtid-2",
    backendSessionId: "bsid-2",
  });

  assert.equal(result.id, "rt-2");
  assert.equal(tableCalls.some((c) => c.table === "actors"), false, "should not query actors when teamId is given");
  const upsert = tableCalls.find((c) => c.table === "agent_runtimes" && c.op === "upsert");
  assert.equal(upsert.row.team_id, "team-explicit");
  assert.deepEqual(upsert.options, { onConflict: "agent_id,backend_session_id" });
});

test("upsertAgentRuntime throws 400 missing_team when team cannot be resolved", async () => {
  const repo = createRepo(fakeSupabase({
    tableData: {
      actors: [], // actor not visible -> no team_id
      agent_runtimes: [{ id: "rt-x" }],
    },
  }));

  await assert.rejects(
    () =>
      repo.upsertAgentRuntime({
        agentActorId: "agent-missing",
        sessionId: "sess-3",
        runtimeId: "rtid-3",
        backendSessionId: "bsid-3",
      }),
    (err: any) => err.statusCode === 400 && err.code === "missing_team",
  );
});

function fakeSupabase({
  rpcCalls = [],
  tableCalls = [],
  rpcData = {},
  rpcErrors = {},
  tableData = {},
  tableErrors = {},
  // Extended hooks for telemetry tests
  onRpc = null,
  onInsert = null,
  onUpsert = null,
  upsertData = null,
} = {}) {
  return {
    async rpc(name, args) {
      rpcCalls.push({ name, args });
      if (onRpc) onRpc(name, args);
      return { data: rpcData[name] ?? [], error: rpcErrors[name] ?? null };
    },
    from(table) {
      return createTableQuery(table, tableCalls, tableData[table] ?? [], tableErrors[table] ?? null, {
        onInsert,
        onUpsert,
        upsertData,
      });
    },
  };
}

function createTableQuery(table: any, calls: any, data: any, error: any, hooks: any = {}) {
  const { onInsert, onUpsert, upsertData } = hooks;
  return {
    select(columns) {
      calls.push({ table, op: "select", columns });
      return createSelectableQuery(table, calls, data, error);
    },
    insert(row) {
      calls.push({ table, op: "insert", row });
      if (onInsert) onInsert(table, row);
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
        // Allow bare insert() to resolve immediately
        then(resolve, reject) {
          return Promise.resolve({ data: null, error }).then(resolve, reject);
        },
      };
    },
    // Single upsert: captures options + call records (agent_runtimes tests) and
    // honors the onUpsert/upsertData hooks (telemetry tests). A prior auto-merge
    // left two same-named upsert methods; the later silently shadowed the former.
    upsert(row, options) {
      calls.push({ table, op: "upsert", row, options });
      if (onUpsert) onUpsert(table, row);
      const resolvedData = upsertData ?? data[0] ?? null;
      return {
        select(columns) {
          calls.push({ table, op: "upsert.select", columns });
          return {
            async single() {
              calls.push({ table, op: "upsert.single" });
              return { data: resolvedData, error };
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
    maybeSingle() {
      calls.push({ table, op: "maybeSingle" });
      return Promise.resolve({ data: data[0] ?? null, error });
    },
    then(resolve, reject) {
      return Promise.resolve({ data, error }).then(resolve, reject);
    },
  };
  return query;
}

// --- Actor directory ---

test("listTeamActors selects actor_directory columns without removed agent_kind", async () => {
  const tableCalls = [];
  const repo = createRepo(fakeSupabase({
    tableCalls,
    tableData: {
      actor_directory: [{
        id: "actor-1",
        team_id: "team-1",
        actor_type: "agent",
        user_id: null,
        invited_by_actor_id: null,
        display_name: "Bot",
        avatar_url: null,
        team_role: null,
        member_status: null,
        agent_status: "idle",
        agent_types: ["claude"],
        default_agent_type: "claude",
        default_workspace_id: null,
        agent_visibility: "team",
        last_active_at: null,
        created_at: "2026-05-27T01:00:00Z",
        updated_at: "2026-05-27T01:00:00Z",
      }],
    },
  }));

  const page = await repo.listTeamActors("team-1", { limit: 10 });
  const selectCall = tableCalls.find((c) => c.table === "actor_directory" && c.op === "select");
  assert.ok(selectCall, "expected actor_directory select");
  assert.ok(!selectCall.columns.includes("agent_kind"), "must not select removed agent_kind column");
  assert.equal(page.items[0].defaultAgentType, "claude");
  assert.equal(page.items[0].agentKind, null);
});

// --- Telemetry TDD tests ---

test("submitFeedback writes team_id, session_id, skill and no note column", async () => {
  let upsertRow = null;
  const repo = createRepo(fakeSupabase({
    onUpsert: (table, row) => { if (table === "actor_message_feedback") upsertRow = row; },
    upsertData: {
      message_id: "m1", actor_id: "a1", team_id: "t1", session_id: "s1",
      kind: "positive", star_rating: null, skill: null, created_at: "2026-05-29T00:00:00Z",
    },
  }));
  const out = await repo.submitFeedback({
    messageId: "m1", actorId: "a1", teamId: "t1", sessionId: "s1", kind: "positive", starRating: null, skill: null,
  });
  assert.equal(upsertRow.team_id, "t1");
  assert.equal(upsertRow.session_id, "s1");
  assert.equal(upsertRow.skill, null);
  assert.ok(!("note" in upsertRow), "must not write a non-existent note column");
  assert.equal(out.kind, "positive");
});

test("getTeamLeaderboard calls the team_leaderboard rpc with period and maps enriched rows", async () => {
  let rpcArgs = null;
  const repo = createRepo(fakeSupabase({
    onRpc: (fn, args) => { rpcArgs = { fn, args }; },
    rpcData: {
      team_leaderboard: [{
        team_id: "t1", actor_id: "a1", display_name: "Alice", period: "week",
        tokens_used: 1000, cost_usd: 0.25, positive_feedback: 3, negative_feedback: 1,
        session_count: 5, skill_usage: { "sentry-fix": 2 }, score: 1000,
      }],
    },
  }));
  const out = await repo.getTeamLeaderboard("t1", { period: "week" });
  assert.equal(rpcArgs.fn, "team_leaderboard");
  assert.deepEqual(rpcArgs.args, { p_team_id: "t1", p_period: "week" });
  assert.equal(out.items[0].tokensUsed, 1000);
  assert.equal(out.items[0].displayName, "Alice");
  assert.deepEqual(out.items[0].skillUsage, { "sentry-fix": 2 });
});

test("submitSessionReport inserts a report row and expands skillUsage into skill rows", async () => {
  const inserts = [];
  const repo = createRepo(fakeSupabase({
    onInsert: (table, rows) => inserts.push({ table, rows }),
  }));
  await repo.submitSessionReport({
    actorId: "a1", teamId: "t1", sessionId: "s1", tokensUsed: 10, costUsd: 0.1,
    model: "m", agentKind: "code", endedAt: "2026-05-29T00:00:00Z", skillUsage: { foo: 2, bar: 1 },
  });
  const report = inserts.find((i) => i.table === "actor_session_report");
  const skills = inserts.find((i) => i.table === "actor_skill_usage");
  assert.equal(report.rows.tokens_used, 10);
  assert.equal(report.rows.agent_kind, "code");
  assert.equal(skills.rows.length, 2);
  assert.deepEqual(skills.rows.map((r) => r.skill).sort(), ["bar", "foo"]);
});
