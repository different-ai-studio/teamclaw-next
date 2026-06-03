import test from "node:test";
import assert from "node:assert/strict";
import { contentRootPath, syncStatePath } from "../harness/docker.mjs";

test("contentRootPath maps to global team dir", () => {
  assert.equal(contentRootPath("team-x"), "/root/.amuxd/teams/team-x/teamclaw-team");
});
test("syncStatePath maps to per-team state", () => {
  assert.equal(syncStatePath("team-x"), "/root/.amuxd/teams/team-x/sync/state.json");
});
