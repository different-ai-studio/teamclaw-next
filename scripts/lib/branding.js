"use strict";
const path = require("path");

/**
 * Apply the configured app name to a parsed tauri.conf.json object (mutates it).
 * Sets `productName` and the first window's `title`. Returns true if anything changed.
 */
function applyNameToTauriConf(tauriConf, buildConfig) {
  const name = buildConfig && buildConfig.app && buildConfig.app.name;
  if (!name) return false;
  let changed = false;
  if (tauriConf.productName !== name) {
    tauriConf.productName = name;
    changed = true;
  }
  const win = tauriConf.app && Array.isArray(tauriConf.app.windows) && tauriConf.app.windows[0];
  if (win && win.title !== name) {
    win.title = name;
    changed = true;
  }
  return changed;
}

/**
 * Build a (side-effect-free) plan describing how to regenerate icons from
 * buildConfig.app.logo. Returns null when no logo is configured.
 */
function resolveLogoPlan(buildConfig, repoRoot) {
  const logo = buildConfig && buildConfig.app && buildConfig.app.logo;
  if (!logo) return null;
  const iconsOutDir = path.join(repoRoot, "apps/desktop/icons");
  return {
    source: path.resolve(repoRoot, logo),
    iconsOutDir,
    generatedIcon: path.join(iconsOutDir, "128x128.png"),
    publicLogoTargets: [
      path.join(repoRoot, "packages/app/public/logo.png"),
      path.join(repoRoot, "packages/app/public/logo-64.png"),
    ],
  };
}

module.exports = { applyNameToTauriConf, resolveLogoPlan };
