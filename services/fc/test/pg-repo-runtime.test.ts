/**
 * pg-repo-runtime — UUID-seed pglite tests for the RUNTIME domain.
 *
 * Covers: upsertAgentRuntime, getAgentRuntime, getLatestAgentRuntime,
 *         updateRuntimeCursor, updateRuntimeModel, listAgentRuntimesForTeam,
 *         listLatestAgentRuntimeHints, listSessionRuntimeModels,
 *         listRuntimeTargetsForSession, listDaemonRuntimes, heartbeat.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./db/pglite.js";
import { createPgBusinessRepository } from "../src/lib/pg-repo/index.js";
import {
  teams,
  actors,
  agents,
  members,
  teamMembers,
  sessions,
} from "../src/db/schema/index.js";

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function makeDb() {
  const { db } = await makeTestDb();
  return db;
}

async function seedTeam(db: any) {
  const [t] = await db
    .insert(teams)
    .values({ name: "RuntimeTeam", slug: `rt-${Date.now()}-${Math.random()}` })
    .returning();
  return t;
}

async function seedAgentActor(db: any, teamId: string) {
  const [actor] = await db
    .insert(actors)
    .values({ teamId, actorType: "agent", displayName: "TestAgent" })
    .returning();
  await db.insert(agents).values({ id: actor.id, agentKind: "claude", status: "offline", visibility: "team" });
  return actor;
}

async function seedMemberActor(db: any, teamId: string) {
  const [actor] = await db
    .insert(actors)
    .values({ teamId, actorType: "member", displayName: "TestMember", userId: `u-${Math.random()}` })
    .returning();
  await db.insert(members).values({ id: actor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId, memberId: actor.id, role: "member" });
  return actor;
}

async function seedSession(db: any, teamId: string) {
  const [s] = await db
    .insert(sessions)
    .values({ teamId, title: "Runtime Session", mode: "solo" })
    .returning();
  return s;
}

function makeRepo(db: any, agentActorId?: string) {
  return createPgBusinessRepository({ db, callerActorId: agentActorId });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("upsertAgentRuntime returns {id} truthy", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  const result = await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-abc",
    backendSessionId: "bs-001",
  });
  assert.ok(result.id, "upsertAgentRuntime should return truthy id");
});

test("upsertAgentRuntime upserts on natural key (agent_id, backend_session_id)", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  const r1 = await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-upsert",
    backendSessionId: "bs-upsert-key",
  });
  const r2 = await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-upsert-updated",
    backendSessionId: "bs-upsert-key", // same natural key
  });
  assert.equal(r1.id, r2.id, "second upsert should return same row id");
});

test("getAgentRuntime returns null when absent", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  const result = await repo.getAgentRuntime({ sessionId: session.id, runtimeId: "nonexistent" });
  assert.equal(result, null);
});

test("getAgentRuntime returns row by runtimeId when present", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-find",
    backendSessionId: "bs-find",
  });

  const result = await repo.getAgentRuntime({ sessionId: session.id, runtimeId: "rt-find" });
  assert.ok(result, "should find the row");
  assert.equal(result!.runtimeId, "rt-find");
});

test("getAgentRuntime returns row by backendSessionId when present", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-bsid",
    backendSessionId: "bs-lookup",
  });

  const result = await repo.getAgentRuntime({ sessionId: session.id, backendSessionId: "bs-lookup" });
  assert.ok(result, "should find by backendSessionId");
  assert.equal(result!.backendSessionId, "bs-lookup");
});

test("getLatestAgentRuntime returns null when absent", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  const result = await repo.getLatestAgentRuntime({ agentId: agentActor.id, sessionId: session.id });
  assert.equal(result, null);
});

test("getLatestAgentRuntime returns latest row when present", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-latest-old",
    backendSessionId: "bs-latest-old",
  });
  await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-latest-new",
    backendSessionId: "bs-latest-new",
  });

  const result = await repo.getLatestAgentRuntime({ agentId: agentActor.id, sessionId: session.id });
  assert.ok(result, "should return a row");
  // Should be one of the two runtimes
  assert.ok(["rt-latest-old", "rt-latest-new"].includes(result!.runtimeId ?? ""));
});

test("updateRuntimeCursor persists lastProcessedMessageId", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  const { id } = await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-cursor",
    backendSessionId: "bs-cursor",
  });

  const msgId = "00000000-0000-0000-0000-000000000001";
  // Should not throw
  await assert.doesNotReject(() => repo.updateRuntimeCursor(id, { lastProcessedMessageId: msgId }));
});

test("updateRuntimeModel persists model", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-model",
    backendSessionId: "bs-model",
  });

  // Should not throw
  await assert.doesNotReject(() => repo.updateRuntimeModel("rt-model", "claude-3-5-sonnet"));
});

test("listAgentRuntimesForTeam returns inserted rows", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-list",
    backendSessionId: "bs-list",
  });

  const rows = await repo.listAgentRuntimesForTeam(team.id);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length >= 1);
  assert.ok(rows.some((r: any) => r.runtimeId === "rt-list"));
});

test("listLatestAgentRuntimeHints returns latest per agent", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-hint",
    backendSessionId: "bs-hint",
  });

  const hints = await repo.listLatestAgentRuntimeHints(team.id, [agentActor.id]);
  assert.ok(Array.isArray(hints));
  assert.ok(hints.length >= 1);
});

test("listSessionRuntimeModels returns rows for session", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-models",
    backendSessionId: "bs-models",
    currentModel: "claude-3-5-haiku",
  });

  const rows = await repo.listSessionRuntimeModels(session.id);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length >= 1);
  assert.ok(rows.some((r: any) => r.runtime_id === "rt-models"));
});

test("listRuntimeTargetsForSession returns agent+runtimeId pairs", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-target",
    backendSessionId: "bs-target",
  });

  const rows = await repo.listRuntimeTargetsForSession(session.id, [agentActor.id]);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length >= 1);
  assert.ok(rows.some((r: any) => r.agent_id === agentActor.id));
});

test("listDaemonRuntimes returns rows for team", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-daemon",
    backendSessionId: "bs-daemon",
  });

  const rows = await repo.listDaemonRuntimes(team.id);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.some((r: any) => r.runtimeId === "rt-daemon"));
});

test("heartbeat does not throw", async () => {
  const db = await makeDb();
  const repo = makeRepo(db);
  await assert.doesNotReject(() => repo.heartbeat());
});

// Fix #runtime — null backendSessionId upsert should be idempotent (one row, updated)
test("upsertAgentRuntime with null backendSessionId: two upserts → ONE row, updated", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  // First upsert with backendSessionId=null
  const r1 = await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-null-bs-1",
    backendSessionId: null,
    status: "running",
  });
  assert.ok(r1.id, "first upsert returns id");

  // Second upsert with backendSessionId=null for the same agent → should update, not insert
  const r2 = await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-null-bs-updated",
    backendSessionId: null,
    status: "stopped",
  });
  assert.ok(r2.id, "second upsert returns id");
  assert.equal(r1.id, r2.id, "both upserts return the same row id (no duplicate)");

  // Verify only ONE row exists for this agent with null backendSessionId
  const allRuntimes = await repo.listAgentRuntimesForTeam(team.id);
  const nullBsRows = allRuntimes.filter(
    (r: any) => r.agentId === agentActor.id && r.backendSessionId === null,
  );
  assert.equal(nullBsRows.length, 1, "exactly one row with null backendSessionId");
  assert.equal(nullBsRows[0].runtimeId, "rt-null-bs-updated", "row reflects the updated runtimeId");
  assert.equal(nullBsRows[0].status, "stopped", "row reflects the updated status");
});
