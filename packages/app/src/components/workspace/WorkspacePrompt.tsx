import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { ArrowRight, CheckCircle2, FolderOpen, FolderPlus, Globe, Sparkles } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { toast } from "sonner"
import { useWorkspaceStore } from "@/stores/workspace"
import { useCurrentTeamStore } from "@/stores/current-team"
import { isTauri } from '@/lib/utils'
import { DEFAULT_WORKSPACE_PATH } from '@/lib/build-config'

interface WorkspaceTeamMeta {
  teamId: string
  teamName: string
}

/**
 * Validate the chosen workspace against the currently-logged-in team.
 *
 * Returns `true` when the workspace is OK to continue with, `false` when the
 * caller should re-prompt the user (after a mismatch was rejected or the user
 * chose a different directory).
 *
 * Rules:
 *  - No current team / not in Tauri → always continue.
 *  - workspace has no teamclaw-team yet → continue, surface a toast so the
 *    user knows they still need to finish team setup in Settings (next PR
 *    will auto-init this).
 *  - meta.teamId === currentTeam.id → continue.
 *  - meta.teamId !== currentTeam.id → ask the user (twice) whether to
 *    discard the existing teamclaw-team directory. If they confirm,
 *    delete it and continue (workspace stays selected, team setup is
 *    pending). If they decline, clear the workspace and return false so
 *    the picker reopens.
 */
async function validateWorkspaceTeam(workspacePath: string): Promise<boolean> {
  if (!isTauri()) return true

  const currentTeam = useCurrentTeamStore.getState().team
  if (!currentTeam) return true

  let meta: WorkspaceTeamMeta | null
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    meta = await invoke<WorkspaceTeamMeta | null>("workspace_read_team_meta", {
      workspacePath,
    })
  } catch (error) {
    console.warn("[Workspace] Failed to read team meta:", error)
    return true
  }

  if (!meta) {
    toast.message(
      "需要在团队设置中完成共享目录初始化",
      { description: `当前工作区还没有 teamclaw-team/，请进入设置 → 团队完成设置。` },
    )
    return true
  }

  if (meta.teamId === currentTeam.id) return true

  const first = window.confirm(
    `该工作区已绑定团队「${meta.teamName}」，与当前登录的团队「${currentTeam.name}」不一致。\n\n继续将删除该工作区中的 teamclaw-team/ 目录并以当前团队重新初始化（其他文件保留不动）。\n\n是否继续？`,
  )
  if (!first) {
    await useWorkspaceStore.getState().clearWorkspace()
    return false
  }

  const second = window.confirm(
    `再次确认：将删除工作区中的 teamclaw-team/ 目录（仅此一个目录）。该操作不可撤销。\n\n确认删除？`,
  )
  if (!second) {
    await useWorkspaceStore.getState().clearWorkspace()
    return false
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("workspace_delete_team_repo", { workspacePath })
  } catch (error) {
    console.error("[Workspace] Failed to delete teamclaw-team:", error)
    toast.error("删除 teamclaw-team 失败", { description: String(error) })
    await useWorkspaceStore.getState().clearWorkspace()
    return false
  }

  toast.message(
    "已清除旧团队目录",
    { description: "请进入设置 → 团队完成当前团队的共享目录初始化。" },
  )
  return true
}

function BrandPill() {
  return (
    <div className="inline-flex items-center gap-1.5 rounded-md border border-border-soft bg-panel/60 px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-faint">
      <Sparkles className="h-3 w-3" />
      TeamClaw
    </div>
  )
}

function FeatureBullet({ title, body }: { title: string; body: string }) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-start gap-x-3">
      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 text-faint" />
      <div className="space-y-1">
        <p className="text-[12.5px] font-semibold text-foreground">{title}</p>
        <p className="text-[12px] leading-5 text-ink-2">{body}</p>
      </div>
    </div>
  )
}

export function WorkspacePrompt() {
  const { t } = useTranslation()
  const setWorkspace = useWorkspaceStore(s => s.setWorkspace)
  const isLoadingWorkspace = useWorkspaceStore(s => s.isLoadingWorkspace)
  const [isWebMode, setIsWebMode] = useState(false)
  const [customPath, setCustomPath] = useState(DEFAULT_WORKSPACE_PATH)

  useEffect(() => {
    const webMode = !isTauri()
    setIsWebMode(webMode)

    // In web mode, automatically set the default workspace
    if (webMode) {
      // Expand ~ to actual home directory path for the server
      // The server will interpret this path
      setWorkspace(DEFAULT_WORKSPACE_PATH)
    }
  }, [setWorkspace])

  const applyWorkspace = async (path: string) => {
    await setWorkspace(path)
    await validateWorkspaceTeam(path)
  }

  const handleSelectFolder = async () => {
    if (isWebMode) {
      // In web mode, use the custom path input
      if (customPath.trim()) {
        await applyWorkspace(customPath.trim())
      }
      return
    }

    // In Tauri mode, use the native dialog
    try {
      const { open } = await import("@tauri-apps/plugin-dialog")
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('workspace.selectWorkspace', 'Select Workspace'),
      })

      if (selected && typeof selected === 'string') {
        await applyWorkspace(selected)
      }
    } catch (error) {
      console.error('Failed to select folder:', error)
    }
  }

  const handleCreateWorkspace = async () => {
    if (!isTauri()) return

    try {
      const [{ save }, { mkdir }, { documentDir }] = await Promise.all([
        import("@tauri-apps/plugin-dialog"),
        import("@tauri-apps/plugin-fs"),
        import("@tauri-apps/api/path"),
      ])

      const documents = await documentDir()
      const selected = await save({
        title: t('workspace.createWorkspace', 'Create Workspace'),
        defaultPath: `${documents.replace(/\/$/, '')}/${t('workspace.newWorkspaceName', 'New Workspace')}`,
      })

      if (!selected || typeof selected !== 'string') return

      await mkdir(selected, { recursive: true })
      await applyWorkspace(selected)
    } catch (error) {
      console.error('Failed to create workspace:', error)
    }
  }

  // In web mode, show a simpler UI with path input
  if (isWebMode) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-6">
        <div className="w-full max-w-xl overflow-hidden rounded-[16px] border border-border-soft bg-paper shadow-[0_12px_40px_-24px_rgba(20,20,15,0.18)]">
          <div className="space-y-5 px-7 py-7">
            <div className="space-y-3">
              <BrandPill />
              <div className="flex items-start gap-3">
                <div className="rounded-[10px] bg-panel p-2.5 text-ink-2">
                  <Globe className="h-5 w-5" />
                </div>
                <div className="space-y-1.5">
                  <h2 className="text-[17px] font-semibold tracking-tight text-foreground">
                    {t('workspace.webMode', 'Web Mode')}
                  </h2>
                  <p className="max-w-md text-[13px] leading-6 text-ink-2">
                    {t('workspace.webModeBody', 'Running in web mode. Enter a workspace path so TeamClaw knows where to read and write project files.')}
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[12.5px] font-medium text-foreground" htmlFor="workspace-path">
                {t('workspace.enterPath', 'Enter workspace path')}
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="workspace-path"
                  value={customPath}
                  onChange={(e) => setCustomPath(e.target.value)}
                  placeholder={t('workspace.enterPath', 'Enter workspace path')}
                  className="h-10 flex-1 rounded-[8px] border-border bg-background font-mono text-[12.5px]"
                />
                <Button
                  onClick={handleSelectFolder}
                  disabled={isLoadingWorkspace || !customPath.trim()}
                  className="h-10 rounded-[8px] px-5"
                >
                  {isLoadingWorkspace ? t('common.loading', 'Loading...') : t('common.confirm', 'Confirm')}
                </Button>
              </div>
            </div>

            <div className="grid gap-4 border-t border-border-soft pt-5 sm:grid-cols-2">
              <FeatureBullet
                title={t('workspace.webModeTipTitle', 'Recommended')}
                body={t('workspace.webModeTipBody', 'Use an absolute path for the smoothest setup, especially when the server runs in a different environment.')}
              />
              <FeatureBullet
                title={t('workspace.webModeAccessTitle', 'Access check')}
                body={t('workspace.webModeAccessBody', 'Make sure the agent has permission to access this directory before continuing.')}
              />
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        className="overflow-hidden border-border-soft bg-paper p-0 shadow-[0_16px_48px_-24px_rgba(20,20,15,0.22)] sm:max-w-[640px]"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <div className="px-8 pt-7 pb-6">
          <div className="space-y-3">
            <BrandPill />
            <DialogHeader className="text-left">
              <DialogTitle className="text-[22px] font-semibold tracking-tight text-foreground">
                {t('workspace.startupPromptTitle', 'Choose a workspace to get started')}
              </DialogTitle>
              <DialogDescription className="max-w-xl text-[13px] leading-6 text-ink-2">
                {t(
                  'workspace.startupPromptBody',
                  'Please choose an existing workspace or create a new one before continuing.',
                )}
              </DialogDescription>
            </DialogHeader>
          </div>

          <div className="mt-5 grid gap-x-6 gap-y-3 border-t border-border-soft pt-4 sm:grid-cols-2">
            <FeatureBullet
              title={t('workspace.startupFeatureFast', 'Fast resume')}
              body={t('workspace.startupFeatureFastDesc', 'If your last workspace is still available, the app will reopen it automatically next time.')}
            />
            <FeatureBullet
              title={t('workspace.startupFeatureSafe', 'Clear first step')}
              body={t('workspace.startupFeatureSafeDesc', 'Choose an existing folder if you already have a project, or create a clean workspace for a new one.')}
            />
          </div>
        </div>

        <div className="grid gap-3 px-8 pb-7 sm:grid-cols-2">
          <button
            type="button"
            onClick={handleSelectFolder}
            disabled={isLoadingWorkspace}
            className="group rounded-[16px] border border-border-soft bg-background p-5 text-left transition-colors hover:border-border hover:bg-selected disabled:pointer-events-none disabled:opacity-60"
          >
            <div className="flex h-full flex-col gap-4">
              <div className="flex items-start justify-between gap-3">
                <div className="rounded-[10px] bg-panel p-2.5 text-ink-2">
                  <FolderOpen className="h-5 w-5" />
                </div>
                <span className="rounded-md bg-panel px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-foreground">
                  {t('workspace.recommended', 'Recommended')}
                </span>
              </div>

              <div className="space-y-1.5">
                <h3 className="text-[14px] font-semibold text-foreground">
                  {t('workspace.selectFolder', 'Select Folder')}
                </h3>
                <p className="text-[12.5px] leading-5 text-ink-2">
                  {t('workspace.selectExistingDesc', 'Open an existing project or directory.')}
                </p>
              </div>

              <div className="mt-1 inline-flex items-center gap-1 text-[12.5px] font-medium text-foreground">
                {isLoadingWorkspace ? t('common.loading', 'Loading...') : t('workspace.openExistingAction', 'Open existing workspace')}
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={handleCreateWorkspace}
            disabled={isLoadingWorkspace}
            className="group rounded-[16px] border border-border-soft bg-background p-5 text-left transition-colors hover:border-border hover:bg-selected disabled:pointer-events-none disabled:opacity-60"
          >
            <div className="flex h-full flex-col gap-4">
              <div className="flex items-start justify-between gap-3">
                <div className="rounded-[10px] bg-panel p-2.5 text-ink-2">
                  <FolderPlus className="h-5 w-5" />
                </div>
                <span className="rounded-md border border-border-soft px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-faint">
                  {t('workspace.newProjectBadge', 'New')}
                </span>
              </div>

              <div className="space-y-1.5">
                <h3 className="text-[14px] font-semibold text-foreground">
                  {t('workspace.createWorkspace', 'Create Workspace')}
                </h3>
                <p className="text-[12.5px] leading-5 text-ink-2">
                  {t('workspace.createWorkspaceDesc', 'Pick a path and create a new empty workspace.')}
                </p>
              </div>

              <div className="mt-1 inline-flex items-center gap-1 text-[12.5px] font-medium text-foreground">
                {t('workspace.createWorkspaceAction', 'Choose location and create')}
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              </div>
            </div>
          </button>
        </div>

        <DialogFooter className="justify-start border-t border-border-soft bg-panel/30 px-8 py-3 sm:justify-start">
          <p className="text-[11.5px] leading-5 text-faint">
            {t(
              'workspace.startupPromptTip',
              'If you already used TeamClaw before, the last available workspace will be opened automatically next time.',
            )}
          </p>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
