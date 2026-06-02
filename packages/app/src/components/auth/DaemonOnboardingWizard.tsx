import * as React from 'react'
import { Loader2, AlertCircle, Users, Lock, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useDaemonOnboardingStore, type Visibility } from '@/stores/daemon-onboarding'

/** Calm segmented control (no heavy solid-black buttons). */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  disabled?: boolean
}) {
  return (
    <div className="inline-flex rounded-[9px] bg-panel p-[3px]">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'rounded-[7px] px-3.5 py-1.5 text-[12.5px] font-medium transition-colors disabled:opacity-50',
              active
                ? 'bg-paper text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11.5px] font-medium uppercase tracking-wide text-faint">{label}</span>
      {children}
    </div>
  )
}

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

  // Loading / transitional states.
  if (status !== 'needs-onboard' && status !== 'mismatch') {
    return (
      <Shell>
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </Shell>
    )
  }

  if (status === 'mismatch') {
    return (
      <Shell title="本机 Agent 属于其他团队" subtitle="当前登录团队与本机 daemon 绑定的团队不一致，需要重置后重新初始化。">
        {error && <ErrorLine error={error} />}
        <Button
          className="mt-1 h-10 w-full rounded-[10px] bg-coral text-paper hover:opacity-90"
          disabled={busy}
          onClick={() => void forceReset()}
        >
          {busy ? <Spinner label="重置中…" /> : '重置并重新初始化'}
        </Button>
      </Shell>
    )
  }

  return (
    <Shell title="初始化本机 Agent" subtitle="新建一个 agent，或把本机绑定到你已有的 agent。">
      <Segmented
        value={mode}
        disabled={busy}
        onChange={(m) => setMode(m)}
        options={[
          { value: 'new', label: '新建' },
          { value: 'bind', label: '绑定已有' },
        ]}
      />

      {mode === 'new' ? (
        <div className="flex flex-col gap-4">
          <Field label="名字">
            <Input
              placeholder="例如：MacBook Pro"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              className="h-10 rounded-[10px] text-[13px]"
            />
          </Field>

          <Field label="可见性">
            <Segmented
              value={visibility}
              disabled={busy}
              onChange={(v) => setVisibility(v)}
              options={[
                { value: 'team', label: '团队可见' },
                { value: 'personal', label: '仅自己' },
              ]}
            />
            <p className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
              {visibility === 'team' ? (
                <>
                  <Users className="h-3 w-3 shrink-0" /> 团队成员都能看到并使用这个 agent。
                </>
              ) : (
                <>
                  <Lock className="h-3 w-3 shrink-0" /> 只有你能看到和使用，团队其他人不可见。
                </>
              )}
            </p>
          </Field>

          {error && <ErrorLine error={error} />}

          <Button
            className="h-10 w-full rounded-[10px] bg-coral text-paper hover:opacity-90"
            disabled={busy || name.trim().length === 0}
            onClick={() => void createNewAgent(name.trim(), visibility)}
          >
            {busy ? <Spinner label="初始化中…" /> : '创建并启动'}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {ownedAgents.length === 0 ? (
            <p className="rounded-[10px] border border-dashed border-border px-4 py-6 text-center text-[12.5px] text-faint">
              当前团队下没有你创建的 agent 可绑定。
            </p>
          ) : (
            ownedAgents.map((a) => (
              <button
                key={a.agentId}
                type="button"
                disabled={busy}
                onClick={() => void bindExistingAgent(a.agentId, a.displayName)}
                className="group flex items-center justify-between rounded-[12px] border border-border bg-paper px-4 py-3 text-left transition-colors hover:bg-selected disabled:opacity-50"
              >
                <span className="flex flex-col">
                  <span className="text-[13px] font-medium text-foreground">{a.displayName || a.agentId}</span>
                  <span className="font-mono text-[11px] text-faint">{a.visibility}</span>
                </span>
                <ChevronRight className="h-4 w-4 text-faint transition-colors group-hover:text-muted-foreground" />
              </button>
            ))
          )}
          {error && <ErrorLine error={error} />}
        </div>
      )}
    </Shell>
  )
}

function Shell({
  title,
  subtitle,
  children,
}: {
  title?: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex h-screen items-center justify-center bg-background px-6" data-tauri-drag-region>
      <div className="w-full max-w-[440px] rounded-[16px] border border-border bg-paper p-6 shadow-sm">
        {title && <h1 className="text-[16px] font-semibold text-foreground">{title}</h1>}
        {subtitle && <p className="mt-1.5 text-[12.5px] leading-5 text-muted-foreground">{subtitle}</p>}
        <div className="mt-5 flex flex-col gap-4">{children}</div>
      </div>
    </div>
  )
}

function Spinner({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-2">
      <Loader2 className="h-4 w-4 animate-spin" /> {label}
    </span>
  )
}

function ErrorLine({ error }: { error: string }) {
  return (
    <p className="flex items-start gap-1.5 text-[11.5px] leading-4 text-coral">
      <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" /> <span className="min-w-0 break-words">{error}</span>
    </p>
  )
}
