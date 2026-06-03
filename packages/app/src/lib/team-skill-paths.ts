import { exists, readTextFile } from '@tauri-apps/plugin-fs'
import { homeDir } from '@tauri-apps/api/path'
import { TEAM_REPO_DIR } from '@/lib/build-config'

function trimTrailingPathSeparators(path: string): string {
  return path.replace(/[/\\]+$/, '')
}

function trimLeadingPathSeparators(path: string): string {
  return path.replace(/^[/\\]+/, '')
}

function isAbsolutePath(path: string): boolean {
  return /^([A-Za-z]:[\\/]|\/|\\\\)/.test(path)
}

function joinPath(parent: string, child: string): string {
  const separator = parent.includes('\\') ? '\\' : '/'
  return `${trimTrailingPathSeparators(parent)}${separator}${trimLeadingPathSeparators(child)}`
}

async function readSkillPathsFromConfig(
  workspacePath: string,
  configFileName: string,
): Promise<string[]> {
  try {
    const configPath = `${workspacePath}/${configFileName}`
    if (!(await exists(configPath))) return []
    const content = await readTextFile(configPath)
    const config = JSON.parse(content) as { skills?: { paths?: unknown } }
    const rawPaths = Array.isArray(config?.skills?.paths) ? config.skills.paths : []
    const home = trimTrailingPathSeparators(await homeDir())
    return rawPaths
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      .map((p) => {
        const trimmed = p.trim()
        if (trimmed === '~') return home
        if (/^~[\\/]/.test(trimmed)) {
          return joinPath(home, trimmed.slice(2))
        }
        return isAbsolutePath(trimmed) ? trimmed : joinPath(workspacePath, trimmed)
      })
  } catch {
    return []
  }
}

/**
 * All directories that should contribute `source: 'team'` skills for a workspace.
 *
 * Sources (deduped):
 * - `teamclaw.json` → `skills.paths`
 * - `opencode.json` → `skills.paths` (legacy / OpenCode-aligned config)
 * - `<workspace>/teamclaw-team/skills` when the team share link exists on disk
 */
export async function collectTeamSkillPaths(workspacePath: string): Promise<string[]> {
  const dirs = new Set<string>()

  for (const path of await readSkillPathsFromConfig(workspacePath, 'teamclaw.json')) {
    dirs.add(path)
  }
  for (const path of await readSkillPathsFromConfig(workspacePath, 'opencode.json')) {
    dirs.add(path)
  }

  const defaultTeamSkillsDir = `${workspacePath}/${TEAM_REPO_DIR}/skills`
  if (await exists(defaultTeamSkillsDir)) {
    dirs.add(defaultTeamSkillsDir)
  }

  return Array.from(dirs)
}

/** Paths from `teamclaw.json` only — used by tests that assert config parsing. */
export async function readConfigSkillPaths(workspacePath: string): Promise<string[]> {
  return readSkillPathsFromConfig(workspacePath, 'teamclaw.json')
}
