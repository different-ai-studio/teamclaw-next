import { isTauri } from "@/lib/utils";

async function expandTildePath(path: string): Promise<string> {
  if (!path.startsWith("~")) return path;
  if (!isTauri()) return path;
  try {
    const { homeDir } = await import("@tauri-apps/api/path");
    const home = await homeDir();
    return path.replace(/^~/, home.replace(/\/$/, ""));
  } catch {
    return path;
  }
}

/** True when `path` exists on this machine (desktop). Web always returns true. */
export async function isWorkspacePathOnLocalMachine(path: string): Promise<boolean> {
  const trimmed = path.trim();
  if (!trimmed) return false;
  if (!isTauri()) return true;
  try {
    const { exists } = await import("@tauri-apps/plugin-fs");
    const expanded = await expandTildePath(trimmed);
    return await exists(expanded);
  } catch {
    return false;
  }
}

/**
 * Compare workspace paths, handling ~/path vs /absolute/path in web mode.
 * In web mode, workspacePath may be ~/some-workspace (not expanded) while
 * agent runtime returns event.directory as /Users/xxx/some-workspace.
 */
function tildeSuffixMatchesAbsolute(tildePath: string, absolutePath: string): boolean {
  if (!tildePath.startsWith("~/")) return false;
  const relParts = tildePath.slice(2).split("/").filter(Boolean);
  if (relParts.length === 0) return false;
  const absParts = absolutePath.split("/").filter(Boolean);
  if (absParts.length < relParts.length) return false;
  const suffix = absParts.slice(-relParts.length);
  return suffix.every((part, i) => part === relParts[i]);
}

export function workspacePathsMatch(a: string, b: string): boolean {
  const na = a.replace(/\/+$/, "").replace(/\\/g, "/");
  const nb = b.replace(/\/+$/, "").replace(/\\/g, "/");
  if (na === nb) return true;
  // Handle ~/rel/path vs /absolute/.../rel/path (same user home expansion).
  // Require the full tilde-relative suffix — not just the last path component —
  // so ~/TeamClaw does not match every teammate's /Users/<name>/TeamClaw row.
  if (tildeSuffixMatchesAbsolute(na, nb) || tildeSuffixMatchesAbsolute(nb, na)) {
    return true;
  }
  return false;
}
