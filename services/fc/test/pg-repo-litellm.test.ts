/**
 * pg-repo-litellm.test.ts
 *
 * Tests for:
 *   - setupLiteLlm (with injected stub provisioner)
 *   - loadTeamWorkspaceGitConfig / saveTeamWorkspaceGitConfig round-trip
 *   - listActorDirectoryForSync
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./db/pglite.js";
import { createPgBusinessRepository } from "../src/lib/pg-repo/index.js";

// Stable UUIDs
const TEAM_A = "b0000000-0000-0000-0000-000000000001";
const TEAM_B = "b0000000-0000-0000-0000-000000000002";
const TEAM_C = "b0000000-0000-0000-0000-000000000003";
const ACTOR_1 = "c0000000-0000-0000-0000-000000000001";

async function seedTeam(pg: any, id: string, name = "Test Team", slug = "test-slug") {
  await pg.exec(
    `INSERT INTO teams (id, slug, name, created_at, updated_at)
     VALUES ('${id}', '${slug}', '${name}', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
  );
}

async function seedActor(pg: any, id: string, teamId: string, type = "member") {
  await pg.exec(
    `INSERT INTO actors (id, team_id, actor_type, display_name, created_at, updated_at)
     VALUES ('${id}', '${teamId}', '${type}', 'Actor One', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
  );
}

// Stub provisioner for tests
function makeStubProvisioner(override?: Partial<{ litellmTeamId: string; aiGatewayEndpoint: string; litellmKey: string }>) {
  return async (_teamName: string) => ({
    litellmTeamId: override?.litellmTeamId ?? "lt-test-123",
    aiGatewayEndpoint: override?.aiGatewayEndpoint ?? "https://gw.example.com/litellm",
    litellmKey: override?.litellmKey ?? "sk-litellm-test-key",
  });
}

// ── setupLiteLlm ──────────────────────────────────────────────────────────────

test("pg-repo [litellm]: setupLiteLlm returns aiGatewayEndpoint and litellmKey", async () => {
  const { db, pg } = await makeTestDb();
  await seedTeam(pg, TEAM_A, "Acme Corp", "acme-corp");

  const repo = createPgBusinessRepository({ db, provisionLiteLlm: makeStubProvisioner() });
  const out = await repo.setupLiteLlm(TEAM_A);

  assert.ok(out, "result must be returned");
  assert.equal(typeof out.aiGatewayEndpoint, "string");
  assert.ok(out.aiGatewayEndpoint.length > 0, "aiGatewayEndpoint must be non-empty");
  assert.equal(typeof out.litellmKey, "string");
  assert.ok(out.litellmKey.length > 0, "litellmKey must be non-empty");
  assert.equal(out.aiGatewayEndpoint, "https://gw.example.com/litellm");
  assert.equal(out.litellmKey, "sk-litellm-test-key");
});

test("pg-repo [litellm]: setupLiteLlm persists litellmTeamId + aiGatewayEndpoint to team_workspace_config", async () => {
  const { db, pg } = await makeTestDb();
  await seedTeam(pg, TEAM_A, "Acme Corp", "acme-corp-2");

  const repo = createPgBusinessRepository({ db, provisionLiteLlm: makeStubProvisioner() });
  await repo.setupLiteLlm(TEAM_A);

  // Read back via getWorkspaceConfig to verify persistence
  const cfg = await repo.getWorkspaceConfig(TEAM_A);
  assert.ok(cfg, "workspace config must exist after setupLiteLlm");
  assert.equal(cfg.litellmTeamId, "lt-test-123");
});

test("pg-repo [litellm]: setupLiteLlm throws 503 when no provisioner injected", async () => {
  const { db, pg } = await makeTestDb();
  await seedTeam(pg, TEAM_B, "No Provisioner Team", "no-prov");

  const repo = createPgBusinessRepository({ db }); // no provisionLiteLlm
  await assert.rejects(
    () => repo.setupLiteLlm(TEAM_B),
    (err: any) => err?.statusCode === 503 || err?.code === "litellm_unavailable",
  );
});

test("pg-repo [litellm]: setupLiteLlm throws 404 for nonexistent team", async () => {
  const { db } = await makeTestDb();

  const repo = createPgBusinessRepository({ db, provisionLiteLlm: makeStubProvisioner() });
  await assert.rejects(
    () => repo.setupLiteLlm("00000000-0000-0000-0000-000000000000"),
    (err: any) => err?.statusCode === 404 || err?.code === "not_found",
  );
});

// ── loadTeamWorkspaceGitConfig / saveTeamWorkspaceGitConfig ───────────────────

test("pg-repo [litellm]: loadTeamWorkspaceGitConfig returns null when absent", async () => {
  const { db, pg } = await makeTestDb();
  await seedTeam(pg, TEAM_B, "No Config Team", "no-config-team");

  const repo = createPgBusinessRepository({ db });
  const cfg = await repo.loadTeamWorkspaceGitConfig(TEAM_B);
  assert.equal(cfg, null);
});

test("pg-repo [litellm]: saveTeamWorkspaceGitConfig + loadTeamWorkspaceGitConfig round-trip", async () => {
  const { db, pg } = await makeTestDb();
  await seedTeam(pg, TEAM_C, "Git Team", "git-team");

  const repo = createPgBusinessRepository({ db });

  // Save using snake_case keys (as supabase-repo does)
  await repo.saveTeamWorkspaceGitConfig({
    team_id: TEAM_C,
    git_url: "https://example.com/team/repo.git",
    git_branch: "main",
    git_token: "tok-secret",
    ai_gateway_endpoint: "https://gw.example.com",
    enabled: true,
  });

  const cfg = await repo.loadTeamWorkspaceGitConfig(TEAM_C);
  assert.ok(cfg, "config must be returned after save");
  assert.equal(cfg.team_id, TEAM_C);
  assert.equal(cfg.git_url, "https://example.com/team/repo.git");
  assert.equal(cfg.git_branch, "main");
  assert.equal(cfg.git_token, "tok-secret");
  assert.equal(cfg.ai_gateway_endpoint, "https://gw.example.com");
  assert.equal(cfg.enabled, true);
});

test("pg-repo [litellm]: saveTeamWorkspaceGitConfig is idempotent (upsert)", async () => {
  const { db, pg } = await makeTestDb();
  await seedTeam(pg, TEAM_C, "Git Team 2", "git-team-2");

  const repo = createPgBusinessRepository({ db });

  await repo.saveTeamWorkspaceGitConfig({ team_id: TEAM_C, git_url: "https://first.example.com/repo.git" });
  await repo.saveTeamWorkspaceGitConfig({ team_id: TEAM_C, git_url: "https://second.example.com/repo.git" });

  const cfg = await repo.loadTeamWorkspaceGitConfig(TEAM_C);
  assert.ok(cfg, "config must exist after upsert");
  assert.equal(cfg.git_url, "https://second.example.com/repo.git");
});

// ── listActorDirectoryForSync ─────────────────────────────────────────────────

test("pg-repo [litellm]: listActorDirectoryForSync returns actors for team", async () => {
  const { db, pg } = await makeTestDb();
  await seedTeam(pg, TEAM_A, "Sync Team", "sync-team");
  await seedActor(pg, ACTOR_1, TEAM_A);

  const repo = createPgBusinessRepository({ db });
  const rows = await repo.listActorDirectoryForSync(TEAM_A, null);

  assert.ok(Array.isArray(rows), "result must be an array");
  assert.ok(rows.length >= 1, "must return at least one actor");

  const row = rows[0];
  assert.equal(row.id, ACTOR_1);
  assert.equal(row.team_id, TEAM_A);
  assert.equal(row.actor_type, "member");
  assert.equal(typeof row.display_name, "string");
  assert.ok("created_at" in row, "created_at must be present");
  assert.ok("updated_at" in row, "updated_at must be present");
});

test("pg-repo [litellm]: listActorDirectoryForSync returns empty for unknown team", async () => {
  const { db } = await makeTestDb();

  const repo = createPgBusinessRepository({ db });
  const rows = await repo.listActorDirectoryForSync("00000000-0000-0000-0000-000000000000", null);
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 0);
});
