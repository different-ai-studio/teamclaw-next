import { useEffect } from 'react'
import { UserMinus, Shield, Pencil, Eye, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTeamMembersStore } from '../../stores/team-members'
import { AddMemberInput } from './AddMemberInput'
import { useWorkspaceStore } from '@/stores/workspace'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

function truncateId(id: string): string {
  if (id.length <= 16) return id
  return `${id.slice(0, 8)}...${id.slice(-8)}`
}

function RoleBadge({ role }: { role?: string }) {
  if (role === 'owner') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 px-1.5 py-0.5 rounded">
        <Shield className="h-3 w-3" />
        Owner
      </span>
    )
  }
  if (role === 'manager') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 px-1.5 py-0.5 rounded">
        <Shield className="h-3 w-3" />
        Manager
      </span>
    )
  }
  if (role === 'viewer') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium bg-gray-100 dark:bg-gray-800/50 text-gray-600 dark:text-gray-400 px-1.5 py-0.5 rounded">
        <Eye className="h-3 w-3" />
        Viewer
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded">
      <Pencil className="h-3 w-3" />
      Editor
    </span>
  )
}

function LocalDeviceBadge() {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="h-2 w-2 rounded-full inline-block bg-blue-500" />
      <span className="text-[10px] text-muted-foreground">This device</span>
    </span>
  )
}

export function TeamMemberList() {
  const {
    members,
    myRole,
    loading,
    error,
    loadMembers,
    loadMyRole,
    addMember,
    removeMember,
    updateMemberRole,
    canManageMembers,
    currentNodeId,
    loadCurrentNodeId,
  } = useTeamMembersStore()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)

  useEffect(() => {
    if (!workspacePath) return
    loadMembers()
    loadMyRole()
    loadCurrentNodeId()
  }, [
    loadCurrentNodeId,
    loadMembers,
    loadMyRole,
    workspacePath,
  ])

  const isManager = canManageMembers()

  const handleAdd = async (nodeId: string, name: string, role: string, label: string) => {
    await addMember({
      nodeId,
      name,
      label,
      role: role as 'editor' | 'viewer',
      platform: '',
      arch: '',
      hostname: '',
      addedAt: new Date().toISOString(),
    })
  }

  return (
    <div className="space-y-4">
      {loading && (
        <p className="text-[13px] text-muted-foreground">Loading members...</p>
      )}
      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}
      <div className="space-y-2">
        {members.map((member) => {
          const isMemberOwner = member.role === 'owner'
          const isMemberManager = member.role === 'manager'
          // Owner can act on anyone except themselves; Manager can only act on editor/viewer
          const canActOnMember =
            isManager &&
            member.nodeId !== currentNodeId &&
            (myRole === 'owner'
              ? !isMemberOwner
              : !isMemberOwner && !isMemberManager)

          return (
            <div
              key={member.nodeId}
              className="flex items-center justify-between bg-muted/50 rounded-md p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {(() => {
                    if (member.nodeId === currentNodeId) return <LocalDeviceBadge />
                    return null
                  })()}
                  <p className="text-[13px] font-medium truncate">
                    {member.name || member.hostname}
                  </p>
                  <RoleBadge role={member.role} />
                </div>
                {member.label && (
                  <p className="text-xs text-muted-foreground truncate">{member.label}</p>
                )}
                <p className="text-xs font-mono text-muted-foreground truncate">
                  {truncateId(member.nodeId)}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {member.platform} {member.arch} · {member.hostname}
                </p>
              </div>
              <div className="flex items-center gap-1">
                {canActOnMember && myRole === 'owner' && (
                  <Select
                    value={member.role}
                    onValueChange={(v) => updateMemberRole(member.nodeId, v as any)}
                  >
                    <SelectTrigger className="h-8 w-[110px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="manager">Manager</SelectItem>
                      <SelectItem value="editor">Editor</SelectItem>
                      <SelectItem value="viewer">Viewer</SelectItem>
                    </SelectContent>
                  </Select>
                )}
                {canActOnMember && myRole === 'manager' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-muted-foreground"
                    onClick={() =>
                      updateMemberRole(
                        member.nodeId,
                        member.role === 'viewer' ? 'editor' : 'viewer'
                      )
                    }
                    aria-label="Toggle role"
                  >
                    {member.role === 'viewer' ? (
                      <Pencil className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                    {member.role === 'viewer' ? 'Set Editor' : 'Set Viewer'}
                  </Button>
                )}
                {canActOnMember && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-destructive hover:text-destructive"
                    onClick={() => removeMember(member.nodeId)}
                    aria-label="Remove"
                  >
                    <UserMinus className="h-4 w-4" />
                    Remove
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {isManager && (
        <div className="pt-2 border-t border-border">
          <div className="flex items-center gap-1.5 mb-2">
            <UserPlus className="h-4 w-4 text-muted-foreground" />
            <span className="text-[13px] font-medium">Add Member</span>
          </div>
          <AddMemberInput onAdd={handleAdd} error={error} myRole={myRole} />
        </div>
      )}
    </div>
  )
}
