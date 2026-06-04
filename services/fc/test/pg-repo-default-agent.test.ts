/**
 * pg-repo — per-member default agent (get/setMemberDefaultAgent).
 *
 * Mirrors the seed pattern in pg-repo-agents.test.ts. The repo resolves the
 * caller's own actor from ctx.userId + teamId, so each test constructs the repo
 * with the seeded member's userId.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { makeTestDb } from "./db/pglite.js";
import { createPgBusinessRepository } from "../src/lib/pg-repo/index.js";
import { teams, actors, members, teamMembers, agents } from "../src/db/schema/index.js";

async function seedTeam(db: any, over: Record<string, any> = {}) {
  const [t] = await db
    .insert(teams)
    .values({ name: "TestTeam", slug: `test-${Date.now()}-${Math.random()}`, ...over })
    .returning();
  return t;
}

async function seedMemberActor(db: any, teamId: string, userId: string) {
  const [actor] = await db
    .insert(actors)
    .values({ teamId, actorType: "member", displayName: "Member", userId })
    .returning();
  await db.insert(members).values({ id: actor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId, memberId: actor.id, role: "member" });
  return actor;
}

async function seedAgentActor(
  db: any,
  teamId: string,
  ownerMemberId: string | null,
  visibility = "team",
  status = "active",
) {
  const [agentActor] = await db
    .insert(actors)
    .values({ teamId, actorType: "agent", displayName: "Bot" })
    .returning();
  await db.insert(agents).values({
    id: agentActor.id,
    agentKind: "claude",
    status,
    visibility,
    ownerMemberId,
  });
  return agentActor;
}

const expectStatus = (status: number) => (err: any) => {
  assert.equal(err?.statusCode, status, `expected ApiError ${status}, got ${err?.statusCode}`);
  return true;
};

test("getMemberDefaultAgent returns null when unset", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id, "user-A");
  void member;
  const repo = createPgBusinessRepository({ db, userId: "user-A" });

  const result = await repo.getMemberDefaultAgent(team.id);
  assert.deepEqual(result, { defaultAgentId: null });
});

test("set then get round-trips a team-visible agent", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id, "user-A");
  const agent = await seedAgentActor(db, team.id, member.id, "team");
  const repo = createPgBusinessRepository({ db, userId: "user-A" });

  const set = await repo.setMemberDefaultAgent(team.id, agent.id);
  assert.equal(set.defaultAgentId, agent.id);
  const get = await repo.getMemberDefaultAgent(team.id);
  assert.equal(get.defaultAgentId, agent.id);
});

test("set accepts a personal agent owned by the caller", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id, "user-A");
  const agent = await seedAgentActor(db, team.id, member.id, "personal");
  const repo = createPgBusinessRepository({ db, userId: "user-A" });

  const set = await repo.setMemberDefaultAgent(team.id, agent.id);
  assert.equal(set.defaultAgentId, agent.id);
});

test("set rejects a personal agent owned by someone else (403)", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const owner = await seedMemberActor(db, team.id, "user-OWNER");
  const caller = await seedMemberActor(db, team.id, "user-A");
  void caller;
  const agent = await seedAgentActor(db, team.id, owner.id, "personal");
  const repo = createPgBusinessRepository({ db, userId: "user-A" });

  await assert.rejects(() => repo.setMemberDefaultAgent(team.id, agent.id), expectStatus(403));
});

test("set rejects an agent from another team (409)", async () => {
  const { db } = await makeTestDb();
  const teamA = await seedTeam(db);
  const teamB = await seedTeam(db);
  await seedMemberActor(db, teamA.id, "user-A");
  const memberB = await seedMemberActor(db, teamB.id, "user-B");
  const agentB = await seedAgentActor(db, teamB.id, memberB.id, "team");
  const repo = createPgBusinessRepository({ db, userId: "user-A" });

  await assert.rejects(() => repo.setMemberDefaultAgent(teamA.id, agentB.id), expectStatus(409));
});

test("set rejects an inactive agent (409)", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id, "user-A");
  const agent = await seedAgentActor(db, team.id, member.id, "team", "disabled");
  const repo = createPgBusinessRepository({ db, userId: "user-A" });

  await assert.rejects(() => repo.setMemberDefaultAgent(team.id, agent.id), expectStatus(409));
});

test("set with null clears the default", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id, "user-A");
  const agent = await seedAgentActor(db, team.id, member.id, "team");
  const repo = createPgBusinessRepository({ db, userId: "user-A" });

  await repo.setMemberDefaultAgent(team.id, agent.id);
  const cleared = await repo.setMemberDefaultAgent(team.id, null);
  assert.equal(cleared.defaultAgentId, null);
});

test("get/set reject a caller with no actor in the team (403)", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  await seedMemberActor(db, team.id, "user-A");
  // user-Z is not a member of this team.
  const repo = createPgBusinessRepository({ db, userId: "user-Z" });

  await assert.rejects(() => repo.getMemberDefaultAgent(team.id), expectStatus(403));
  await assert.rejects(() => repo.setMemberDefaultAgent(team.id, null), expectStatus(403));
});

test("deleting the agent clears the default (ON DELETE SET NULL)", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id, "user-A");
  const agent = await seedAgentActor(db, team.id, member.id, "team");
  const repo = createPgBusinessRepository({ db, userId: "user-A" });

  await repo.setMemberDefaultAgent(team.id, agent.id);
  // Deleting the agent actor cascades to agents and nulls members.default_agent_id.
  await db.delete(actors).where(eq(actors.id, agent.id));
  const get = await repo.getMemberDefaultAgent(team.id);
  assert.equal(get.defaultAgentId, null);
});
