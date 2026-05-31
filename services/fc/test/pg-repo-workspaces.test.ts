/**
 * pg-repo-workspaces.test.ts — workspaces domain tests
 *
 * Uses UUID-format IDs compatible with pg schema strict uuid columns.
 * Covers: listWorkspaces, upsertWorkspace, getWorkspace, patchWorkspace,
 * listWorkspacesByIdsSlim, getTeamWorkspaceConfig (null), putTeamWorkspaceConfig
 * (round-trip incl defaultWorkspaceId / pinnedWorkspaceIds).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./db/pglite.js";
import { createPgBusinessRepository } from "../src/lib/pg-repo/index.js";

// Stable UUIDs
const T1   = "b0000000-0000-0000-0000-000000000001";
const TNOCFG = "b0000000-0000-0000-0000-000000000099";
const W1   = "c0000000-0000-0000-0000-000000000001";
const W2   = "c0000000-0000-0000-0000-000000000002";
const WNEW = "c0000000-0000-0000-0000-000000000003";

async function makeRepo() {
  const { db, pg } = await makeTestDb();
  const repo = createPgBusinessRepository({ db });
  return { db, pg, repo };
}

async function seedTeam(pg: any, id: string, slug = "team-slug") {
  await pg.exec(
    `INSERT INTO teams (id, slug, name, created_at, updated_at)
     VALUES ('${id}', '${slug}', 'Test Team', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
  );
}

async function seedWorkspace(pg: any, id: string, teamId: string, name: string, path: string | null = null) {
  await pg.exec(
    `INSERT INTO workspaces (id, team_id, name, path, archived, created_at, updated_at)
     VALUES ('${id}', '${teamId}', '${name}', ${path ? `'${path}'` : "NULL"}, false, NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
  );
}

// ── listWorkspaces ────────────────────────────────────────────────────────────

test("pg-repo [workspaces]: listWorkspaces returns items with contract keys", async () => {
  const { pg, repo } = await makeRepo();
  await seedTeam(pg, T1, "t1-slug");
  await seedWorkspace(pg, W1, T1, "Alpha");

  const { items } = await repo.listWorkspaces({ teamId: T1, limit: 50, cursor: null });
  assert.ok(Array.isArray(items));
  assert.ok(items.length >= 1, "must include at least one workspace");
  assert.deepEqual(Object.keys(items[0]).sort(), [
    "archived", "createdAt", "id", "metadata", "name", "slug", "teamId", "updatedAt",
  ].sort());
  assert.equal(items[0].id, W1);
  assert.equal(items[0].name, "Alpha");
  assert.equal(items[0].archived, false);
  assert.equal(items[0].metadata, null);
});

test("pg-repo [workspaces]: listWorkspaces keyset cursor pages correctly", async () => {
  const { pg, repo } = await makeRepo();
  await seedTeam(pg, T1, "t1-cursor-slug");
  await seedWorkspace(pg, W1, T1, "Alpha");
  await seedWorkspace(pg, W2, T1, "Beta");

  const page1 = await repo.listWorkspaces({ teamId: T1, limit: 1, cursor: null });
  assert.equal(page1.items.length, 1);
  const cursor = { updatedAt: page1.items[0].updatedAt };
  const page2 = await repo.listWorkspaces({ teamId: T1, limit: 50, cursor });
  // Should have at most 1 more item (or 0 if timestamps are equal)
  assert.ok(page2.items.length <= 1);
});

// ── upsertWorkspace ───────────────────────────────────────────────────────────

test("pg-repo [workspaces]: upsertWorkspace inserts new row", async () => {
  const { pg, repo } = await makeRepo();
  await seedTeam(pg, T1, "t1-upsert-slug");

  const w = await repo.upsertWorkspace({ id: WNEW, teamId: T1, name: "New Workspace" });
  assert.equal(w.id, WNEW);
  assert.equal(w.archived, false);
  assert.equal(w.name, "New Workspace");
});

test("pg-repo [workspaces]: upsertWorkspace updates existing row", async () => {
  const { pg, repo } = await makeRepo();
  await seedTeam(pg, T1, "t1-upsert2-slug");
  await seedWorkspace(pg, W1, T1, "Original");

  const w = await repo.upsertWorkspace({ id: W1, teamId: T1, name: "Updated" });
  assert.equal(w.id, W1);
  assert.equal(w.name, "Updated");
});

// ── getWorkspace ──────────────────────────────────────────────────────────────

test("pg-repo [workspaces]: getWorkspace returns named workspace", async () => {
  const { pg, repo } = await makeRepo();
  await seedTeam(pg, T1, "t1-get-slug");
  await seedWorkspace(pg, W1, T1, "Alpha");

  const w = await repo.getWorkspace(W1);
  assert.ok(w, "workspace should exist");
  assert.equal(w.name, "Alpha");
  assert.equal(w.id, W1);
});

test("pg-repo [workspaces]: getWorkspace returns null for missing id", async () => {
  const { pg: _, repo } = await makeRepo();
  const w = await repo.getWorkspace("00000000-0000-0000-0000-000000000000");
  assert.equal(w, null);
});

// ── patchWorkspace ────────────────────────────────────────────────────────────

test("pg-repo [workspaces]: patchWorkspace archives workspace", async () => {
  const { pg, repo } = await makeRepo();
  await seedTeam(pg, T1, "t1-patch-slug");
  await seedWorkspace(pg, W1, T1, "Alpha");

  const w = await repo.patchWorkspace(W1, { archived: true });
  assert.ok(w, "should return patched workspace");
  assert.equal(w.archived, true);
});

test("pg-repo [workspaces]: patchWorkspace updates slug (path)", async () => {
  const { pg, repo } = await makeRepo();
  await seedTeam(pg, T1, "t1-patch2-slug");
  await seedWorkspace(pg, W1, T1, "Alpha");

  const w = await repo.patchWorkspace(W1, { slug: "my-slug" });
  assert.ok(w);
  assert.equal(w.slug, "my-slug");
});

test("pg-repo [workspaces]: patchWorkspace binds and unbinds agentId", async () => {
  const { pg, repo } = await makeRepo();
  await seedTeam(pg, T1, "t1-patch-agent-slug");
  await seedWorkspace(pg, W1, T1, "Alpha");

  // mapWorkspace doesn't surface agentId, so assert the column directly.
  const AGENT = "11111111-1111-4111-8111-111111111111";
  await repo.patchWorkspace(W1, { agentId: AGENT });
  const bound = await pg.query("SELECT agent_id FROM workspaces WHERE id = $1", [W1]);
  assert.equal(bound.rows[0].agent_id, AGENT);

  await repo.patchWorkspace(W1, { agentId: null });
  const unbound = await pg.query("SELECT agent_id FROM workspaces WHERE id = $1", [W1]);
  assert.equal(unbound.rows[0].agent_id, null);
});

// ── getTeamWorkspaceConfig null ───────────────────────────────────────────────

test("pg-repo [workspaces]: getTeamWorkspaceConfig returns null when absent", async () => {
  const { pg, repo } = await makeRepo();
  await seedTeam(pg, TNOCFG, "team-no-config-ws-slug");

  const cfg = await repo.getTeamWorkspaceConfig(TNOCFG);
  assert.equal(cfg, null);
});

// ── putTeamWorkspaceConfig round-trip ─────────────────────────────────────────

test("pg-repo [workspaces]: putTeamWorkspaceConfig upserts and getTeamWorkspaceConfig confirms persistence", async () => {
  const { pg, repo } = await makeRepo();
  await seedTeam(pg, T1, "t1-wscfg-slug");
  await seedWorkspace(pg, W1, T1, "Alpha");

  const out = await repo.putTeamWorkspaceConfig(T1, {
    defaultWorkspaceId: W1,
    pinnedWorkspaceIds: [],
  });
  assert.equal(out.defaultWorkspaceId, W1);
  assert.deepEqual(out.pinnedWorkspaceIds, []);

  const cfg = await repo.getTeamWorkspaceConfig(T1);
  assert.ok(cfg, "config should exist after put");
  assert.equal(cfg.defaultWorkspaceId, W1);
  assert.deepEqual(cfg.pinnedWorkspaceIds, []);
});

test("pg-repo [workspaces]: putTeamWorkspaceConfig round-trip with pinnedWorkspaceIds", async () => {
  const { pg, repo } = await makeRepo();
  await seedTeam(pg, T1, "t1-wscfg2-slug");
  await seedWorkspace(pg, W1, T1, "Alpha");
  await seedWorkspace(pg, W2, T1, "Beta");

  const out = await repo.putTeamWorkspaceConfig(T1, {
    defaultWorkspaceId: W1,
    pinnedWorkspaceIds: [W1, W2],
  });
  assert.equal(out.defaultWorkspaceId, W1);
  assert.deepEqual(out.pinnedWorkspaceIds, [W1, W2]);

  // re-read confirms persistence
  const cfg = await repo.getTeamWorkspaceConfig(T1);
  assert.ok(cfg);
  assert.deepEqual(cfg.pinnedWorkspaceIds, [W1, W2]);
});

test("pg-repo [workspaces]: putTeamWorkspaceConfig is idempotent (upsert)", async () => {
  const { pg, repo } = await makeRepo();
  await seedTeam(pg, T1, "t1-wscfg3-slug");
  await seedWorkspace(pg, W1, T1, "Alpha");
  await seedWorkspace(pg, W2, T1, "Beta");

  await repo.putTeamWorkspaceConfig(T1, { defaultWorkspaceId: W1, pinnedWorkspaceIds: [] });
  const out = await repo.putTeamWorkspaceConfig(T1, { defaultWorkspaceId: W2, pinnedWorkspaceIds: [W1] });
  assert.equal(out.defaultWorkspaceId, W2);

  const cfg = await repo.getTeamWorkspaceConfig(T1);
  assert.ok(cfg);
  assert.equal(cfg.defaultWorkspaceId, W2);
  assert.deepEqual(cfg.pinnedWorkspaceIds, [W1]);
});
