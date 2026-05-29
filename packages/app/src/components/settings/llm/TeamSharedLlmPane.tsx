import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import { Loader2 } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { HostLlmConfig, type LlmModelEntry } from '@/components/settings/team/HostLlmConfig'
import {
  buildTeamProviderConfig,
  loadTeamProviderFormState,
  removeTeamProviderFile,
  saveTeamProviderFile,
} from '@/lib/team-provider'
import { isTauri } from '@/lib/utils'
import { humanizeFcError } from '@/lib/fc-error'
import { ensureJwtSynced } from '@/lib/jwt-bridge'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspacePath: string
  /** Called after a successful save so the caller can reload the shared model. */
  onSaved?: () => void
}

interface TeamStatusLlm {
  baseUrl: string
  model?: string
  modelName?: string
  models?: LlmModelEntry[]
}

/**
 * Modal dialog (styled like "Add Custom") for the team-shared ("host") LLM —
 * the checkbox + proxy base URL + model list block from TeamGitConfig — opened
 * from the local LLM settings screen. Owner-only entry point. Loads and
 * persists through the same team-provider helpers + `update_team_llm_config`,
 * so this and the Team settings tab stay in sync.
 */
export function TeamSharedLlmPane({ open, onOpenChange, workspacePath, onSaved }: Props) {
  const { t } = useTranslation()
  const [enabled, setEnabled] = React.useState(false)
  const [baseUrl, setBaseUrl] = React.useState('')
  const [models, setModels] = React.useState<LlmModelEntry[]>([])
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Load the current config each time the dialog opens, so it reflects edits
  // made from the Team settings tab without a full reload.
  React.useEffect(() => {
    if (!open || !workspacePath || !isTauri()) return
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        await ensureJwtSynced(workspacePath)
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
    setError(null)
    try {
      await ensureJwtSynced(workspacePath)
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
      onSaved?.()
      onOpenChange(false)
    } catch (err) {
      setError(humanizeFcError(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('settings.llm.teamSharedModel', '团队共享模型')}</DialogTitle>
          <DialogDescription>
            {t(
              'settings.team.hostLlmPaneDesc',
              '为团队配置共享 AI 模型代理地址与模型列表，所有成员可直接使用。',
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto py-2">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('common.loading', '加载中…')}
            </div>
          ) : (
            <HostLlmConfig
              enabled={enabled}
              onEnabledChange={setEnabled}
              baseUrl={baseUrl}
              onBaseUrlChange={setBaseUrl}
              models={models}
              onModelsChange={setModels}
              disabled={saving}
            />
          )}
          {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.close', '关闭')}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving || loading}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {t('settings.team.saveLlm', '保存')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
