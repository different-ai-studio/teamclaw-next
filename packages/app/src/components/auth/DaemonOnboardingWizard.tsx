import * as React from 'react'
import { Loader2, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useDaemonOnboardingStore, type Visibility } from '@/stores/daemon-onboarding'

export function DaemonOnboardingWizard({ onDone }: { onDone: () => void }) {
  const { status, busy, error, ownedAgents, refresh, loadOwnedAgents, createNewAgent, bindExistingAgent, forceReset } =
    useDaemonOnboardingStore()
  const [mode, setMode] = React.useState<'new' | 'bind'>('new')
  const [name, setName] = React.useState('')
  const [visibility, setVisibility] = React.useState<Visibility>('team')

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  React.useEffect(() => {
    if (status === 'ready') onDone()
  }, [status, onDone])

  React.useEffect(() => {
    if (mode === 'bind') void loadOwnedAgents()
  }, [mode, loadOwnedAgents])

  if (status === 'mismatch') {
    return (
      <Shell>
        <h1 className="text-[15px] font-bold text-foreground">本机 Agent 属于其他团队</h1>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          当前登录团队与本机 daemon 绑定的团队不一致,需要重置后重新初始化。
        </p>
        {error && <ErrorLine error={error} />}
        <Button className="mt-3 h-10 bg-coral text-paper hover:opacity-90" disabled={busy} onClick={() => void forceReset()}>
          {busy ? '重置中…' : '重置并重新初始化'}
        </Button>
      </Shell>
    )
  }

  if (status !== 'needs-onboard') {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <Shell>
      <h1 className="text-[15px] font-bold text-foreground">初始化本机 Agent</h1>
      <p className="mt-1 text-[12.5px] text-muted-foreground">新建一个 agent,或把本机绑定到你已有的 agent。</p>

      <div className="mt-3 flex gap-2">
        <Button size="sm" variant={mode === 'new' ? 'default' : 'outline'} onClick={() => setMode('new')}>新建</Button>
        <Button size="sm" variant={mode === 'bind' ? 'default' : 'outline'} onClick={() => setMode('bind')}>绑定已有</Button>
      </div>

      {mode === 'new' ? (
        <div className="mt-3 flex flex-col gap-3">
          <Input placeholder="Agent 名字" value={name} onChange={(e) => setName(e.target.value)} className="h-10" />
          <div className="flex gap-2">
            <Button size="sm" variant={visibility === 'team' ? 'default' : 'outline'} onClick={() => setVisibility('team')}>团队可见</Button>
            <Button size="sm" variant={visibility === 'personal' ? 'default' : 'outline'} onClick={() => setVisibility('personal')}>仅自己</Button>
          </div>
          {error && <ErrorLine error={error} />}
          <Button
            className="h-10 bg-coral text-paper hover:opacity-90"
            disabled={busy || name.trim().length === 0}
            onClick={() => void createNewAgent(name.trim(), visibility)}
          >
            {busy ? '初始化中…' : '创建并启动'}
          </Button>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {ownedAgents.length === 0 ? (
            <p className="text-[12.5px] text-faint">没有可绑定的 agent。</p>
          ) : (
            ownedAgents.map((a) => (
              <button
                key={a.agentId}
                disabled={busy}
                onClick={() => void bindExistingAgent(a.agentId, a.displayName)}
                className="flex items-center justify-between rounded-[16px] border border-border bg-paper p-4 text-left hover:bg-selected disabled:opacity-50"
              >
                <span className="text-[13px] font-semibold text-foreground">{a.displayName || a.agentId}</span>
                <span className="font-mono text-[11px] text-faint">{a.visibility}</span>
              </button>
            ))
          )}
          {error && <ErrorLine error={error} />}
        </div>
      )}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen flex-col bg-background" data-tauri-drag-region>
      <div className="h-10 shrink-0" data-tauri-drag-region />
      <div className="mx-auto flex w-full max-w-[460px] flex-1 flex-col justify-center px-6 pb-12">{children}</div>
    </div>
  )
}

function ErrorLine({ error }: { error: string }) {
  return (
    <p className="flex items-center gap-1 text-[11.5px] text-coral">
      <AlertCircle className="h-3 w-3" /> {error}
    </p>
  )
}
