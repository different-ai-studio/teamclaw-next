"use strict";

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

module.exports = { applyNameToTauriConf };
