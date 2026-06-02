import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTeamShareStore } from '@/stores/team-share'

interface Props {
  teamId: string
  workspacePath: string
  onSaved?: () => void
}

const HEX64 = /^[0-9a-fA-F]{64}$/

/**
 * Standalone team-secret input. Validates 64-hex-char client-side,
 * then calls team_share_set_team_secret.
 *
 * Reused by JoinTeamFlow (Task 12) and by settings UIs for member
 * onboarding where the joiner must paste the secret from the inviter.
 */
export function TeamSecretEntry({ teamId, workspacePath, onSaved }: Props) {
  const { t } = useTranslation()
  const setSecret = useTeamShareStore((s) => s.setSecret)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedOk, setSavedOk] = useState(false)

  const trimmed = value.trim()
  const valid = HEX64.test(trimmed)

  async function handleSave() {
    if (!valid) {
      setError(t('settings.teamSecret.invalidError'))
      return
    }
    setSaving(true)
    setError(null)
    setSavedOk(false)
    try {
      await setSecret(teamId, trimmed.toLowerCase(), workspacePath)
      setSavedOk(true)
      onSaved?.()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2">
      <Label htmlFor="team-secret">{t('settings.teamSecret.label')}</Label>
      <Input
        id="team-secret"
        className="font-mono text-[12px]"
        placeholder="64 hex characters"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          setError(null)
          setSavedOk(false)
        }}
      />
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={handleSave} disabled={saving || !valid}>
          {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          {t('common.save')}
        </Button>
        {!valid && trimmed.length > 0 && (
          <span className="text-[12px] text-amber-600">
            {t('settings.teamSecret.lengthHint')}
          </span>
        )}
        {savedOk && (
          <span className="text-[12px] text-emerald-600">{t('settings.teamSecret.savedOk')}</span>
        )}
      </div>
      {error && <p className="text-[12px] text-red-500">{error}</p>}
    </div>
  )
}
