"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { applyNameToTauriConf } = require("./branding");

test("applyNameToTauriConf sets productName and window title from app.name", () => {
  const conf = { productName: "TeamClaw", app: { windows: [{ title: "TeamClaw" }] } };
  const changed = applyNameToTauriConf(conf, { app: { name: "Acme" } });
  assert.strictEqual(changed, true);
  assert.strictEqual(conf.productName, "Acme");
  assert.strictEqual(conf.app.windows[0].title, "Acme");
});

test("applyNameToTauriConf is a no-op when app.name is absent", () => {
  const conf = { productName: "TeamClaw", app: { windows: [{ title: "TeamClaw" }] } };
  const changed = applyNameToTauriConf(conf, { app: {} });
  assert.strictEqual(changed, false);
  assert.strictEqual(conf.productName, "TeamClaw");
});

test("applyNameToTauriConf tolerates missing windows array", () => {
  const conf = { productName: "TeamClaw", app: {} };
  const changed = applyNameToTauriConf(conf, { app: { name: "Acme" } });
  assert.strictEqual(changed, true);
  assert.strictEqual(conf.productName, "Acme");
});
