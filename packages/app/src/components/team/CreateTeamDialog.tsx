import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export interface CreateTeamDialogResult {
  team_id: string
  team_slug: string
}

interface Props {
  workspacePath: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (result: CreateTeamDialogResult) => void
}

/**
 * Name-only "Create Team" dialog. Invokes the slim Rust
 * `team_share_create` command which only creates the row in
 * `teams`. Share-mode (S3/Git/P2P) and LiteLLM stay disabled
 * and must be opted into separately via:
 *   - 设置 → 团队共享 → 「开启共享」
 *   - LLM 配置 → 团队 LiteLLM
 */
export function CreateTeamDialog({
  workspacePath,
  open,
  onOpenChange,
  onCreated,
}: Props) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmed = name.trim()
  const canSubmit = trimmed.length > 0 && !busy

  async function handleSubmit() {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const r = await invoke<CreateTeamDialogResult>('team_share_create', {
        name: trimmed,
        workspacePath,
      })
      onCreated?.(r)
      setName('')
      onOpenChange(false)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>创建团队</DialogTitle>
          <DialogDescription>
            创建后请在「设置 → 团队共享」与「LLM 配置」中分别开通共享与 LiteLLM。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="create-team-name">团队名称</Label>
          <Input
            id="create-team-name"
            value={name}
            placeholder="例如：设计组"
            autoFocus
            disabled={busy}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void handleSubmit()
              }
            }}
          />
          {error && (
            <p className="text-[12px] text-red-500" role="alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
