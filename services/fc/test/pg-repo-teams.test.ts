import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { makeTestDb } from "./db/pglite.js";
import { createPgBusinessRepository } from "../src/lib/pg-repo/index.js";
import { teams, teamWorkspaceConfig, actors, members, teamMembers, teamInvites, agents } from "../src/db/schema/index.js";

async function seedOwner(db: any) {
  const [t] = await db.insert(teams).values({ name: "T", slug: `t-${Date.now()}-${Math.random()}` }).returning();
  const userId = crypto.randomUUID();
  const [actor] = await db.insert(actors).values({ teamId: t.id, actorType: "member", displayName: "Owner", userId }).returning();
  await db.insert(members).values({ id: actor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId: t.id, memberId: actor.id, role: "owner" });
  return { teamId: t.id, userId, actorId: actor.id };
}

async function seedTeam(db: any, over: Record<string, any> = {}) {
  const [t] = await db.insert(teams).values({ name: "Acme", slug: "acme", ...over }).returning();
  return t;
}

test("listTeams returns mapped rows ordered by created_at", async () => {
  const { db } = await makeTestDb();
  await seedTeam(db, { name: "A", slug: "a" });
  await seedTeam(db, { name: "B", slug: "b" });
  const repo = createPgBusinessRepository({ db, accessToken: "x" });
  const rows = await repo.listTeams({ limit: 50 });
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["createdAt","gitAuthKind","gitRemoteUrl","id","name","shareEnabledAt","shareMode","slug"]);
});

test("getTeam returns one team or null", async () => {
  const { db } = await makeTestDb();
  const t = await seedTeam(db);
  const repo = createPgBusinessRepository({ db, accessToken: "x" });
  const got = await repo.getTeam(t.id);
  assert.equal(got.id, t.id);
  assert.equal(got.name, "Acme");
  assert.equal(await repo.getTeam("00000000-0000-0000-0000-000000000000"), null);
});

test("renameTeam updates name", async () => {
  const { db } = await makeTestDb();
  const t = await seedTeam(db);
  const repo = createPgBusinessRepository({ db, accessToken: "x" });
  const out = await repo.renameTeam(t.id, { name: "Renamed" });
  assert.equal(out.id, t.id);
  assert.equal(out.name, "Renamed");
});

test("getShareMode null for fresh team, reflects enabled mode", async () => {
  const { db } = await makeTestDb();
  const t = await seedTeam(db);
  const repo = createPgBusinessRepository({ db, accessToken: "x" });
  assert.deepEqual(await repo.getShareMode(t.id), { mode: null, enabledAt: null, gitRemoteUrl: null, gitAuthKind: null });
  await repo.enableShareMode(t.id, "managed_git", null);
  const sm = await repo.getShareMode(t.id);
  assert.equal(sm.mode, "managed_git");
  assert.equal(typeof sm.enabledAt, "string");
});

test("enableShareMode can switch modes on the same team", async () => {
  const { db } = await makeTestDb();
  const t = await seedTeam(db);
  const repo = createPgBusinessRepository({ db, accessToken: "x" });
  await repo.enableShareMode(t.id, "oss", null);
  await repo.enableShareMode(t.id, "managed_git", null);
  const sm = await repo.getShareMode(t.id);
  assert.equal(sm.mode, "managed_git");
});

test("enableShareMode custom_git stores git fields", async () => {
  const { db } = await makeTestDb();
  const t = await seedTeam(db);
  const repo = createPgBusinessRepository({ db, accessToken: "x" });
  const out = await repo.enableShareMode(t.id, "custom_git", { remoteUrl: "git@x:y.git", authKind: "ssh_key", credentialRef: "ref1" });
  assert.equal(out.shareMode, "custom_git");
  assert.equal(out.gitRemoteUrl, "git@x:y.git");
  assert.equal(out.gitAuthKind, "ssh_key");
});

test("get/putTeamWorkspaceConfig roundtrip; getWorkspaceConfig merges", async () => {
  const { db } = await makeTestDb();
  const t = await seedTeam(db);
  const repo = createPgBusinessRepository({ db, accessToken: "x" });
  assert.equal(await repo.getTeamWorkspaceConfig(t.id), null);
  await db.insert(teamWorkspaceConfig).values({ teamId: t.id, syncMode: "oss", litellmTeamId: "lt1" });
  const wc = await repo.getWorkspaceConfig(t.id);
  assert.equal(wc.syncMode, "oss");
  assert.equal(wc.litellmTeamId, "lt1");
  assert.equal(wc.shareMode, null);
});

test("createTeam requires userId context", async () => {
  const { db } = await makeTestDb();
  const repo = createPgBusinessRepository({ db, accessToken: "x" }); // no userId
  await assert.rejects(() => repo.createTeam({ name: "x" }), /userId is required|bad_request/i);
});

test("pg createTeamInvite persists kind and agentKind for agent invites", async () => {
  const { db } = await makeTestDb();
  const { teamId, userId } = await seedOwner(db);
  const repo = createPgBusinessRepository({ db, userId });
  const result = await repo.createTeamInvite(teamId, {
    kind: "agent", displayName: "Build Bot", agentKind: "claude", teamRole: null, targetActorId: null,
  });
  assert.ok(result.token, "token present");
  assert.ok(result.inviteId, "pg repo returns inviteId");
  const [row] = await db.select().from(teamInvites).where(eq(teamInvites.token, result.token));
  assert.equal(row.kind, "agent");
  assert.equal(row.agentKind, "claude");
});

test("pg createTeamInvite rejects re-invite by non-owner and allows owner", async () => {
  const { db } = await makeTestDb();
  const { teamId, userId: ownerUser, actorId: ownerActor } = await seedOwner(db);
  const [agentActor] = await db.insert(actors).values({ teamId, actorType: "agent", displayName: "A1" }).returning();
  await db.insert(agents).values({ id: agentActor.id, agentKind: "claude", status: "active", visibility: "team", ownerMemberId: ownerActor });
  const otherUser = crypto.randomUUID();
  const [otherActor] = await db.insert(actors).values({ teamId, actorType: "member", displayName: "Other", userId: otherUser }).returning();
  await db.insert(members).values({ id: otherActor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId, memberId: otherActor.id, role: "member" });

  const otherRepo = createPgBusinessRepository({ db, userId: otherUser });
  await assert.rejects(
    () => otherRepo.createTeamInvite(teamId, { kind: "agent", displayName: "x", agentKind: "claude", targetActorId: agentActor.id }),
    /forbidden|owner/i,
  );
  const ownerRepo = createPgBusinessRepository({ db, userId: ownerUser });
  const ok = await ownerRepo.createTeamInvite(teamId, { kind: "agent", displayName: "x", agentKind: "claude", targetActorId: agentActor.id });
  assert.ok(ok.token);
});
