import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { getBackend } from '@/lib/backend'
import { useActorsForTeam, type ActorRow as ActorRowData } from '@/components/panel/ActorsView'
import { LocalDaemonRow } from '@/components/sidebar/LocalDaemonRow'
import { getLocalDaemonAgent } from '@/lib/daemon-agent-admin'
import { ActorDetailDialog } from '@/components/sidebar/ActorDetailDialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useMemberPreferencesStore } from '@/stores/member-preferences-store'

/**
 * The local daemon agent, pinned to the BOTTOM of the sidebar (just above the
 * Settings footer) inside a small bordered card. Previously this row lived at
 * the top of Recents; giving it a deliberate home of its own keeps its
 * coral-emphasized styling from looking out of place among the recent contacts.
 *
 * Self-contained: it resolves the local daemon actor itself and owns the
 * detail / remove dialogs and copy handlers (ActorsSection no longer renders
 * the daemon row, it only filters the daemon out of the Recents list).
 */
export function LocalDaemonCard() {
  const { t } = useTranslation()
  const { actors, refetch, teamId } = useActorsForTeam()
  const defaultAgentId = useMemberPreferencesStore((s) => s.defaultAgentId)

  const [detailFor, setDetailFor] = React.useState<ActorRowData | null>(null)
  const [removeFor, setRemoveFor] = React.useState<ActorRowData | null>(null)
  const [removing, setRemoving] = React.useState(false)

  const [localDaemonAgentId, setLocalDaemonAgentId] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!teamId) { setLocalDaemonAgentId(null); return }
    let cancelled = false
    void getLocalDaemonAgent(teamId).then((a) => { if (!cancelled) setLocalDaemonAgentId(a?.id ?? null) })
    return () => { cancelled = true }
  }, [teamId])

  const localDaemonActor = React.useMemo(
    () => actors.find((a) => a.id === localDaemonAgentId) ?? null,
    [actors, localDaemonAgentId],
  )

  const handleCopyName = async (actor: ActorRowData) => {
    try {
      await navigator.clipboard.writeText(actor.display_name)
      toast.success(t('actors.copiedName', 'Copied name'))
    } catch {
      toast.error(t('actors.copyFailed', 'Copy failed'))
    }
  }

  const handleCopyId = async (actor: ActorRowData) => {
    try {
      await navigator.clipboard.writeText(actor.id)
      toast.success(t('actors.copiedId', 'Copied actor ID'))
    } catch {
      toast.error(t('actors.copyFailed', 'Copy failed'))
    }
  }

  const confirmRemove = async () => {
    if (!removeFor || !teamId) return
    setRemoving(true)
    try {
      await getBackend().teams.removeTeamActor(teamId, removeFor.id)
      toast.success(t('actors.removed', 'Removed from team'))
      setRemoveFor(null)
      refetch()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      toast.error(t('actors.removeFailed', 'Remove failed: {{msg}}', { msg }))
    } finally {
      setRemoving(false)
    }
  }

  if (!localDaemonActor) return null

  return (
    <>
      <ActorDetailDialog
        actor={detailFor}
        teamId={teamId}
        onOpenChange={(open) => { if (!open) setDetailFor(null) }}
      />
      <AlertDialog open={!!removeFor} onOpenChange={(open) => { if (!open) setRemoveFor(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('actors.removeConfirm.titleAgent', 'Remove agent?')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('actors.removeConfirm.body', 'Remove {{name}} from the team. This cannot be undone.', { name: removeFor?.display_name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRemove} disabled={removing}>
              {t('actors.removeConfirm.cta', 'Remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div className="flex max-h-[45vh] flex-col overflow-y-auto rounded-lg border border-border-soft bg-paper p-1 shadow-sm">
        <LocalDaemonRow
          actor={localDaemonActor}
          isDefault={localDaemonActor.id === defaultAgentId}
          onViewDetail={setDetailFor}
          onCopyName={handleCopyName}
          onCopyId={handleCopyId}
          onRequestRemove={setRemoveFor}
        />
      </div>
    </>
  )
}
