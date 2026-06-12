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

/**
 * Apply the configured bundle identifier and deep-link scheme to a parsed
 * tauri.conf.json object (mutates it). Both are optional. Throws (to fail the
 * build) when a provided value is malformed. Returns true if anything changed.
 *
 * - identifier: reverse-DNS, ≥2 dot-separated segments, [A-Za-z0-9-] per segment
 *   (Tauri's rule: no underscores).
 * - scheme: a URL scheme — must start with a letter, then [a-z0-9+.-].
 *   Uppercase is rejected; supply a lowercase scheme.
 */
function applyIdentityToTauriConf(tauriConf, buildConfig) {
  const app = (buildConfig && buildConfig.app) || {};
  let changed = false;

  if (app.identifier) {
    if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(app.identifier)) {
      throw new Error(
        `brand identity: invalid identifier '${app.identifier}' — must be reverse-DNS (e.g. com.acme.app), letters/digits/hyphens, no underscores`
      );
    }
    if (tauriConf.identifier !== app.identifier) {
      tauriConf.identifier = app.identifier;
      changed = true;
    }
  }

  if (app.scheme) {
    if (!/^[a-z][a-z0-9+.-]*$/.test(app.scheme)) {
      throw new Error(
        `brand identity: invalid scheme '${app.scheme}' — must start with a lowercase letter, then [a-z0-9+.-]`
      );
    }
    if (!tauriConf.plugins) tauriConf.plugins = {};
    if (!tauriConf.plugins["deep-link"]) tauriConf.plugins["deep-link"] = {};
    if (!tauriConf.plugins["deep-link"].desktop) tauriConf.plugins["deep-link"].desktop = {};
    const desktop = tauriConf.plugins["deep-link"].desktop;
    if (desktop.schemes?.length !== 1 || desktop.schemes[0] !== app.scheme) {
      desktop.schemes = [app.scheme];
      changed = true;
    }
  }

  return changed;
}

module.exports = { applyNameToTauriConf, resolveLogoPlan, applyIdentityToTauriConf };
