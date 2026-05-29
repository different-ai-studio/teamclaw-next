import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import { Check, Loader2 } from 'lucide-react'

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { HostLlmConfig, type LlmModelEntry } from '@/components/settings/team/HostLlmConfig'
import {
  buildTeamProviderConfig,
  loadTeamProviderFormState,
  removeTeamProviderFile,
  saveTeamProviderFile,
} from '@/lib/team-provider'
import { isTauri } from '@/lib/utils'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspacePath: string
}

interface TeamStatusLlm {
  baseUrl: string
  model?: string
  modelName?: string
  models?: LlmModelEntry[]
}

/**
 * Side pane that surfaces the team-shared ("host") LLM config — the same
 * checkbox + base URL + model list block from TeamGitConfig — from inside the
 * local LLM settings screen. Loads and persists through the same team-provider
 * helpers + `update_team_llm_config`, so the two entry points stay in sync.
 */
export function TeamSharedLlmPane({ open, onOpenChange, workspacePath }: Props) {
  const { t } = useTranslation()
  const [enabled, setEnabled] = React.useState(false)
  const [baseUrl, setBaseUrl] = React.useState('')
  const [models, setModels] = React.useState<LlmModelEntry[]>([])
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [saved, setSaved] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Load the current config each time the pane opens, so it reflects edits made
  // from the Team settings tab without a full reload.
  React.useEffect(() => {
    if (!open || !workspacePath || !isTauri()) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setSaved(false)
    ;(async () => {
      try {
        const formState = await loadTeamProviderFormState(workspacePath)
        if (cancelled) return
        if (formState) {
          setEnabled(formState.enabled)
          setBaseUrl(formState.baseUrl)
          setModels(formState.models)
          return
        }
        const status = await invoke<{ llm?: TeamStatusLlm }>('get_team_status', {
          workspacePath,
        })
        if (cancelled) return
        if (status.llm?.baseUrl) {
          setEnabled(true)
          setBaseUrl(status.llm.baseUrl)
          if (status.llm.models?.length) {
            setModels(status.llm.models)
          } else if (status.llm.model) {
            setModels([{ id: status.llm.model, name: status.llm.modelName || status.llm.model }])
          }
        }
      } catch {
        // No team provider yet — leave the form at its empty defaults.
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, workspacePath])

  const handleSave = async () => {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      await invoke('update_team_llm_config', {
        llmBaseUrl: enabled ? baseUrl || null : null,
        llmModel: enabled ? models[0]?.id || null : null,
        llmModelName: enabled ? models[0]?.name || null : null,
        llmModels: enabled && models.length > 0 ? JSON.stringify(models) : null,
        workspacePath,
      })
      const providerConfig = buildTeamProviderConfig(enabled, baseUrl, models)
      if (providerConfig) {
        await saveTeamProviderFile(workspacePath, providerConfig, models[0]?.id)
      } else if (!enabled) {
        // Explicitly turning the shared LLM off is the only path that removes
        // the provider file — mirrors TeamGitConfig.handleSaveLlmConfig.
        await removeTeamProviderFile(workspacePath)
      }
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-md gap-0 p-0">
        <SheetHeader className="border-b border-border-soft">
          <SheetTitle>
            {t('settings.llm.teamSharedModel', '团队共享模型')}
          </SheetTitle>
          <SheetDescription>
            {t(
              'settings.team.hostLlmPaneDesc',
              '为团队配置共享 AI 模型代理地址与模型列表，所有成员可直接使用。',
            )}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('common.loading', '加载中…')}
            </div>
          ) : (
            <HostLlmConfig
              enabled={enabled}
              onEnabledChange={(v) => {
                setEnabled(v)
                setSaved(false)
              }}
              baseUrl={baseUrl}
              onBaseUrlChange={(v) => {
                setBaseUrl(v)
                setSaved(false)
              }}
              models={models}
              onModelsChange={(v) => {
                setModels(v)
                setSaved(false)
              }}
              disabled={saving}
            />
          )}
          {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
        </div>

        <SheetFooter className="flex-row items-center justify-end gap-2 border-t border-border-soft">
          {saved && !saving && (
            <span className="mr-auto flex items-center gap-1 text-xs text-muted-foreground">
              <Check className="h-3.5 w-3.5" />
              {t('settings.team.llmSaved', '已保存')}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.close', '关闭')}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving || loading}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {t('settings.team.saveLlm', '保存')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
