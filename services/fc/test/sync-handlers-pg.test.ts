/**
 * sync-handlers-pg.test.ts
 *
 * Tests for the BACKEND_KIND=postgres path in sync-handlers.ts.
 * Uses a pglite in-memory DB and a mock S3 client — no real OSS or Supabase.
 */

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { S3Client } from "@aws-sdk/client-s3";
import { makeTestDb } from "./db/pglite.js";
import { makeOssSyncRepo } from "../src/lib/pg-repo/oss-sync.js";
import {
  teams,
  actors,
  members,
  teamMembers,
  teamWorkspaceConfig,
} from "../src/db/schema/index.js";
import {
  handleSyncManifest,
  handleSyncUploadPrepare,
  handleSyncUploadComplete,
  handleSyncDownload,
  handleSyncDelete,
  handleSyncVersions,
  handleSyncSetMode,
  handleSyncTeamMode,
} from "../src/lib/sync-handlers.js";

// ---------------------------------------------------------------------------
// Force BACKEND_KIND=postgres
// ---------------------------------------------------------------------------

const origBackendKind = process.env.BACKEND_KIND;

before(() => {
  process.env.BACKEND_KIND = "postgres";
});

after(() => {
  if (origBackendKind === undefined) {
    delete process.env.BACKEND_KIND;
  } else {
    process.env.BACKEND_KIND = origBackendKind;
  }
});

// ---------------------------------------------------------------------------
// Mock S3 client
// ---------------------------------------------------------------------------

interface MockS3State {
  objects: Map<string, number>; // key → size
  headShouldFail?: boolean;
}

function makeMockS3(state: MockS3State) {
  return {
    send(cmd: any) {
      const name = cmd.constructor?.name ?? "";

      if (name === "HeadObjectCommand") {
        const key = cmd.input?.Key as string;
        if (state.headShouldFail) {
          const err: any = new Error("NoSuchKey");
          err.$metadata = { httpStatusCode: 404 };
          err.Code = "NoSuchKey";
          return Promise.reject(err);
        }
        const size = state.objects.get(key);
        if (size === undefined) {
          const err: any = new Error("NoSuchKey");
          err.$metadata = { httpStatusCode: 404 };
          err.Code = "NoSuchKey";
          return Promise.reject(err);
        }
        return Promise.resolve({ ContentLength: size });
      }

      if (name === "PutObjectCommand" || name === "GetObjectCommand") {
        // Just need to succeed for getSignedUrl to work
        return Promise.resolve({});
      }

      return Promise.reject(new Error(`Unknown command: ${name}`));
    },
  };
}

// Override getSignedUrl for tests (we don't actually need real AWS signing)
// We monkey-patch by injecting a fake s3 that returns a fake presigned URL.
// Since getSignedUrl calls s3.send internally, we need a smarter mock.
// Instead, we use a wrapper that intercepts getSignedUrl via the s3 object.
// Actually, the simplest approach: use the real getSignedUrl with a mock s3
// that returns a response with the right shape — but getSignedUrl doesn't
// actually call send(). It just serializes the command. So we just need an
// s3 client with the right config. Let's use a thin shim:

function makeMockS3WithPresign(state: MockS3State) {
  const base = new S3Client({
    region: "cn-hangzhou",
    endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    forcePathStyle: false,
  });
  // Override send to use mock behavior
  const origSend = base.send.bind(base);
  (base as any).send = (cmd: any) => {
    const name = cmd.constructor?.name ?? "";
    if (name === "HeadObjectCommand") {
      const key = cmd.input?.Key as string;
      if (state.headShouldFail) {
        const err: any = new Error("NoSuchKey");
        err.$metadata = { httpStatusCode: 404 };
        err.Code = "NoSuchKey";
        return Promise.reject(err);
      }
      const size = state.objects.get(key);
      if (size === undefined) {
        const err: any = new Error("NoSuchKey");
        err.$metadata = { httpStatusCode: 404 };
        err.Code = "NoSuchKey";
        return Promise.reject(err);
      }
      return Promise.resolve({ ContentLength: size });
    }
    // For presign commands (PutObject/GetObject), let the real client handle serialization
    return origSend(cmd);
  };
  return base;
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

let _slugCounter = 0;

async function seedTeam(db: any) {
  const slug = `handler-test-${Date.now()}-${_slugCounter++}`;
  const [t] = await db.insert(teams).values({ name: "HandlerTeam", slug }).returning();
  await db
    .insert(teamWorkspaceConfig)
    .values({ teamId: t.id, syncMode: "oss", ossChangeSeq: 0 });
  return t;
}

async function seedMember(db: any, teamId: string, role = "member", userId?: string) {
  const uid = userId ?? `user-${Math.random().toString(36).slice(2)}`;
  const [actor] = await db
    .insert(actors)
    .values({ teamId, actorType: "member", displayName: "Tester", userId: uid })
    .returning();
  await db.insert(members).values({ id: actor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId, memberId: actor.id, role });
  return actor;
}

function makeCaller(teamId: string, actorId: string, userId = "user-1") {
  return { userId, teamId, actorId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sync-handlers postgres path", () => {
  test("uploadPrepare: returns presignedPut + sessionId when blob missing", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    const s3State: MockS3State = { objects: new Map() }; // no blob in OSS
    const s3 = makeMockS3WithPresign(s3State);

    const caller = makeCaller(team.id, actor.id);
    const res = await handleSyncUploadPrepare(
      caller,
      {
        path: "skills/hello.md",
        parentVersion: 0,
        contentHash: "abc123def456abc123def456abc123de",
        size: 42,
      },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.uploadSessionId, "should have uploadSessionId");
    assert.equal(body.requiresUpload, true);
    assert.ok(body.presignedPut, "should have presignedPut URL");
    assert.ok(body.ossKey.includes(team.id), "ossKey should contain teamId");
  });

  test("uploadPrepare: requiresUpload=false when blob already in OSS", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    const hash = "cafecafecafecafecafecafecafecafe";
    const ossKey = `teams/${team.id}/blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
    const s3State: MockS3State = { objects: new Map([[ossKey, 100]]) };
    const s3 = makeMockS3WithPresign(s3State);

    const res = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "skills/b.txt", parentVersion: 0, contentHash: hash, size: 100 },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.requiresUpload, false);
    assert.equal(body.presignedPut, null);
  });

  test("uploadComplete: advances version and returns changeSeq", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    // Prepare
    const hash = "deadbeefdeadbeefdeadbeefdeadbeef";
    const size = 50;
    const ossKey = `teams/${team.id}/blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
    const s3State: MockS3State = { objects: new Map() };
    const s3 = makeMockS3WithPresign(s3State);

    const prepRes = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "skills/file.md", parentVersion: 0, contentHash: hash, size },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );
    const sessionId = JSON.parse(prepRes.body).uploadSessionId;

    // Simulate blob uploaded to OSS
    s3State.objects.set(ossKey, size);

    const completeRes = await handleSyncUploadComplete(
      makeCaller(team.id, actor.id),
      { uploadSessionId: sessionId },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );

    assert.equal(completeRes.statusCode, 200);
    const body = JSON.parse(completeRes.body);
    assert.equal(body.version, 1);
    assert.equal(body.contentHash, hash);
    assert.ok(body.changeSeq >= 1);
  });

  test("manifest: reflects uploaded file", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    const hash = "feedfeedfeedfeedfeedfeedfeedfeed";
    const size = 77;
    const ossKey = `teams/${team.id}/blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
    const s3State: MockS3State = { objects: new Map([[ossKey, size]]) };
    const s3 = makeMockS3WithPresign(s3State);

    // Prepare + complete
    const pr = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "skills/manifest-test.md", parentVersion: 0, contentHash: hash, size },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );
    const sessionId = JSON.parse(pr.body).uploadSessionId;
    await handleSyncUploadComplete(
      makeCaller(team.id, actor.id),
      { uploadSessionId: sessionId },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );

    // Manifest afterSeq=0
    const mRes = await handleSyncManifest(
      makeCaller(team.id, actor.id),
      { afterSeq: 0 },
      { db, repo }
    );

    assert.equal(mRes.statusCode, 200);
    const body = JSON.parse(mRes.body);
    assert.ok(Array.isArray(body.items));
    const found = body.items.find((i: any) => i.path === "skills/manifest-test.md");
    assert.ok(found, "uploaded file should appear in manifest");
    assert.equal(found.contentHash, hash);
    assert.equal(found.deleted, false);
  });

  test("download: returns presigned GET URL", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    const hash = "a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4";
    const size = 200;
    const ossKey = `teams/${team.id}/blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
    const s3State: MockS3State = { objects: new Map([[ossKey, size]]) };
    const s3 = makeMockS3WithPresign(s3State);

    // Prepare + complete to register verified blob
    const pr = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "skills/dl-test.bin", parentVersion: 0, contentHash: hash, size },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );
    await handleSyncUploadComplete(
      makeCaller(team.id, actor.id),
      { uploadSessionId: JSON.parse(pr.body).uploadSessionId },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );

    const dlRes = await handleSyncDownload(
      makeCaller(team.id, actor.id),
      { contentHash: hash },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );

    assert.equal(dlRes.statusCode, 200);
    const body = JSON.parse(dlRes.body);
    assert.ok(body.downloadUrl, "should have downloadUrl");
    assert.equal(body.size, size);
    assert.equal(body.ttlSec, 900);
  });

  test("delete: tombstones file", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    const hash = "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0";
    const size = 10;
    const ossKey = `teams/${team.id}/blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
    const s3State: MockS3State = { objects: new Map([[ossKey, size]]) };
    const s3 = makeMockS3WithPresign(s3State);

    // Upload first
    const pr = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "skills/to-delete.md", parentVersion: 0, contentHash: hash, size },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );
    await handleSyncUploadComplete(
      makeCaller(team.id, actor.id),
      { uploadSessionId: JSON.parse(pr.body).uploadSessionId },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );

    // Delete
    const delRes = await handleSyncDelete(
      makeCaller(team.id, actor.id),
      { path: "skills/to-delete.md", parentVersion: 1 },
      { db, repo }
    );

    assert.equal(delRes.statusCode, 200);
    const body = JSON.parse(delRes.body);
    assert.equal(body.version, 2);
    assert.ok(body.changeSeq >= 2);

    // Manifest should show deleted=true
    const mRes = await handleSyncManifest(
      makeCaller(team.id, actor.id),
      { afterSeq: 0 },
      { db, repo }
    );
    const items = JSON.parse(mRes.body).items;
    const item = items.find((i: any) => i.path === "skills/to-delete.md");
    assert.ok(item, "deleted file should appear in manifest");
    assert.equal(item.deleted, true);
  });

  test("versions: lists version history", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    const hash1 = "1111111111111111111111111111111a";
    const hash2 = "2222222222222222222222222222222b";
    const size = 5;

    const makeOssKey = (h: string) =>
      `teams/${team.id}/blobs/sha256/${h.slice(0, 2)}/${h.slice(2, 4)}/${h}`;

    const s3State: MockS3State = {
      objects: new Map([
        [makeOssKey(hash1), size],
        [makeOssKey(hash2), size],
      ]),
    };
    const s3 = makeMockS3WithPresign(s3State);

    // Upload version 1
    const pr1 = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "skills/versions-test.md", parentVersion: 0, contentHash: hash1, size },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );
    await handleSyncUploadComplete(
      makeCaller(team.id, actor.id),
      { uploadSessionId: JSON.parse(pr1.body).uploadSessionId },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );

    // Upload version 2
    const pr2 = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "skills/versions-test.md", parentVersion: 1, contentHash: hash2, size },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );
    await handleSyncUploadComplete(
      makeCaller(team.id, actor.id),
      { uploadSessionId: JSON.parse(pr2.body).uploadSessionId },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );

    const vRes = await handleSyncVersions(
      makeCaller(team.id, actor.id),
      { path: "skills/versions-test.md" },
      { db, repo }
    );

    assert.equal(vRes.statusCode, 200);
    const body = JSON.parse(vRes.body);
    assert.ok(Array.isArray(body.versions));
    assert.equal(body.versions.length, 2);
    // Newest first
    assert.equal(body.versions[0].version, 2);
    assert.equal(body.versions[1].version, 1);
  });

  test("set-mode: owner can set mode", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const owner = await seedMember(db, team.id, "owner");

    const res = await handleSyncSetMode(
      owner.userId,
      { teamId: team.id, mode: "git" },
      { db, repo }
    );

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).mode, "git");
  });

  test("set-mode: non-owner gets 403", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const member = await seedMember(db, team.id, "member");

    const res = await handleSyncSetMode(
      member.userId,
      { teamId: team.id, mode: "git" },
      { db, repo }
    );

    assert.equal(res.statusCode, 403);
  });

  test("team-mode: reads current sync mode", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const member = await seedMember(db, team.id);

    const res = await handleSyncTeamMode(
      member.userId,
      { teamId: team.id },
      { db, repo }
    );

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    // seedTeam sets syncMode='oss'
    assert.equal(body.mode, "oss");
  });

  test("delete: cas-mismatch returns 409", async () => {
    const { db } = await makeTestDb();
    const repo = makeOssSyncRepo(db);
    const team = await seedTeam(db);
    const actor = await seedMember(db, team.id);

    const hash = "abababababababababababababababab01";
    const size = 8;
    const ossKey = `teams/${team.id}/blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
    const s3State: MockS3State = { objects: new Map([[ossKey, size]]) };
    const s3 = makeMockS3WithPresign(s3State);

    const pr = await handleSyncUploadPrepare(
      makeCaller(team.id, actor.id),
      { path: "skills/cas-test.md", parentVersion: 0, contentHash: hash, size },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );
    await handleSyncUploadComplete(
      makeCaller(team.id, actor.id),
      { uploadSessionId: JSON.parse(pr.body).uploadSessionId },
      { db, repo, s3: s3 as any, bucket: "test-bucket" }
    );

    // Delete with wrong parentVersion (0 instead of 1)
    const res = await handleSyncDelete(
      makeCaller(team.id, actor.id),
      { path: "skills/cas-test.md", parentVersion: 0 },
      { db, repo }
    );

    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.body).reason, "cas-mismatch");
  });
});
