import { useState } from 'react'
import { useTranslation } from 'react-i18next'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTeamShareStore } from '@/stores/team-share'
import { humanizeFcError } from '@/lib/fc-error'

type Mode = 'oss' | 'managed_git' | 'custom_git'
type AuthKind = 'ssh_key' | 'https_token'

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  teamId: string
  workspacePath: string
  onSuccess?: () => void
}

export function EnableShareWizard({
  open,
  onOpenChange,
  teamId,
  workspacePath,
  onSuccess,
}: Props) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<Mode>('oss')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [authKind, setAuthKind] = useState<AuthKind>('ssh_key')
  const [credential, setCredential] = useState('')
  const [branch, setBranch] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const enableOss = useTeamShareStore((s) => s.enableOss)
  const enableManagedGit = useTeamShareStore((s) => s.enableManagedGit)
  const enableCustomGit = useTeamShareStore((s) => s.enableCustomGit)

  // For SSH the credential is optional: an empty key means "use this machine's
  // ~/.ssh / ssh-agent" (the daemon falls back to local SSH). HTTPS always needs
  // a token.
  const customGitValid =
    mode !== 'custom_git' ||
    (remoteUrl.trim().length > 0 &&
      (authKind === 'ssh_key' || credential.trim().length > 0))
  const canSubmit = !submitting && customGitValid

  function reset() {
    setMode('oss')
    setRemoteUrl('')
    setAuthKind('ssh_key')
    setCredential('')
    setBranch('')
    setError(null)
  }

  async function handleSubmit() {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      if (mode === 'oss') {
        await enableOss(teamId, workspacePath)
      } else if (mode === 'managed_git') {
        await enableManagedGit(teamId, workspacePath)
      } else {
        await enableCustomGit(teamId, workspacePath, {
          remote_url: remoteUrl.trim(),
          auth_kind: authKind,
          credential: credential.trim(),
          branch: branch.trim() || undefined,
        })
      }
      onSuccess?.()
      reset()
      onOpenChange(false)
    } catch (e) {
      setError(humanizeFcError(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!submitting) onOpenChange(v)
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.teamShare.enableTitle')}</DialogTitle>
          <DialogDescription>
            {t('settings.teamShare.enableDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <fieldset className="space-y-2">
            <legend className="text-[12.5px] font-medium text-foreground">
              {t('settings.teamShare.shareModeLegend')}
            </legend>
            <ModeRadio
              value="oss"
              checked={mode === 'oss'}
              onChange={() => setMode('oss')}
              label="OSS"
              desc={t('settings.teamShare.modeOssDesc')}
            />
            <ModeRadio
              value="managed_git"
              checked={mode === 'managed_git'}
              onChange={() => setMode('managed_git')}
              label={t('settings.teamShare.modeManagedGitLabel')}
              desc={t('settings.teamShare.modeManagedGitDesc')}
            />
            <ModeRadio
              value="custom_git"
              checked={mode === 'custom_git'}
              onChange={() => setMode('custom_git')}
              label={t('settings.teamShare.modeCustomGitLabel')}
              desc={t('settings.teamShare.modeCustomGitDesc')}
            />
          </fieldset>

          {mode === 'custom_git' && (
            <div className="space-y-3 rounded-md border border-border-soft bg-surface p-3">
              <div className="space-y-1.5">
                <Label htmlFor="share-remote-url">
                  {t('settings.teamShare.remoteUrlLabel')}
                </Label>
                <Input
                  id="share-remote-url"
                  placeholder="git@github.com:org/repo.git"
                  value={remoteUrl}
                  onChange={(e) => setRemoteUrl(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="share-auth-kind">
                  {t('settings.teamShare.authKindLabel')}
                </Label>
                <select
                  id="share-auth-kind"
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-[13px]"
                  value={authKind}
                  onChange={(e) => setAuthKind(e.target.value as AuthKind)}
                >
                  <option value="ssh_key">
                    {t('settings.teamShare.sshPrivateKey')}
                  </option>
                  <option value="https_token">HTTPS Token</option>
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="share-credential">
                  {authKind === 'ssh_key'
                    ? t('settings.teamShare.sshKeyLabelOptional')
                    : 'HTTPS Token'}
                </Label>
                <textarea
                  id="share-credential"
                  className="min-h-[80px] w-full break-all rounded-md border border-input bg-transparent p-2 font-mono text-[12px]"
                  placeholder={
                    authKind === 'ssh_key'
                      ? t('settings.teamShare.sshKeyPlaceholder')
                      : t('settings.teamShare.tokenPlaceholder')
                  }
                  value={credential}
                  onChange={(e) => setCredential(e.target.value)}
                />
                {authKind === 'ssh_key' && (
                  <p className="text-[11px] text-muted-foreground">
                    {t('settings.teamShare.sshLocalHint')}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="share-branch">
                  {t('settings.teamShare.branchLabel')}
                </Label>
                <Input
                  id="share-branch"
                  placeholder="main"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                />
              </div>
            </div>
          )}

          <p className="text-[12px] text-amber-600">
            {t('settings.teamShare.lockWarning')}
          </p>

          {error && <p className="text-[12px] text-red-500">{error}</p>}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {t('settings.teamShare.confirmEnable')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ModeRadio({
  value,
  checked,
  onChange,
  label,
  desc,
}: {
  value: string
  checked: boolean
  onChange: () => void
  label: string
  desc: string
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border-soft bg-surface p-2.5 hover:bg-panel">
      <input
        type="radio"
        name="share-mode"
        value={value}
        checked={checked}
        onChange={onChange}
        className="mt-1"
      />
      <div className="flex-1">
        <div className="text-[13px] font-medium">{label}</div>
        <div className="text-[12px] text-muted-foreground">{desc}</div>
      </div>
    </label>
  )
}
