import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SessionContinueBanner } from '@/components/chat/SessionContinueBanner'

export type LocalAgentWelcomeAgent = {
  id: string
  displayName: string
}

type QuickAction = {
  labelKey: string
  labelDefault: string
  shortLabelKey: string
  shortLabelDefault: string
  messageKey: string
  messageDefault: string
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    labelKey: 'chat.localAgentWelcome.quickActions.workspaceChanges',
    labelDefault: '查看 workspace 改动',
    shortLabelKey: 'chat.localAgentWelcome.quickActionsShort.workspace',
    shortLabelDefault: 'workspace',
    messageKey: 'chat.localAgentWelcome.quickMessages.workspaceChanges',
    messageDefault: '帮我看看当前 workspace 有什么改动',
  },
  {
    labelKey: 'chat.localAgentWelcome.quickActions.projectStructure',
    labelDefault: '总结项目结构',
    shortLabelKey: 'chat.localAgentWelcome.quickActionsShort.structure',
    shortLabelDefault: '结构',
    messageKey: 'chat.localAgentWelcome.quickMessages.projectStructure',
    messageDefault: '总结一下这个项目的技术栈',
  },
  {
    labelKey: 'chat.localAgentWelcome.quickActions.writeReport',
    labelDefault: '写一份报告',
    shortLabelKey: 'chat.localAgentWelcome.quickActionsShort.report',
    shortLabelDefault: '报告',
    messageKey: 'chat.localAgentWelcome.quickMessages.writeReport',
    messageDefault: '/{写报告} ',
  },
]

export type LocalAgentWelcomeEmptyStateProps = {
  agent: LocalAgentWelcomeAgent | null
  agentLoading?: boolean
  starting?: boolean
  onStartConversation: () => void
  onQuickAction: (message: string) => void
  onOpenAgentSettings: () => void
}

function TextLink({
  children,
  primary,
  disabled,
  onClick,
  className,
  title,
}: {
  children: React.ReactNode
  primary?: boolean
  disabled?: boolean
  onClick?: () => void
  className?: string
  title?: string
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={cn(
        'shrink-0 border-none bg-transparent p-0 text-[14px] text-ink-2',
        'underline decoration-border underline-offset-[3px]',
        'transition-colors hover:text-foreground hover:decoration-border',
        'disabled:cursor-not-allowed disabled:opacity-40',
        primary &&
          'font-semibold text-coral no-underline hover:underline hover:decoration-coral',
        className,
      )}
    >
      {children}
    </button>
  )
}

function BlinkCursor() {
  return <span className="terminal-caret" aria-hidden />
}

export function LocalAgentWelcomeEmptyState({
  agent,
  agentLoading = false,
  starting = false,
  onStartConversation,
  onQuickAction,
  onOpenAgentSettings,
}: LocalAgentWelcomeEmptyStateProps) {
  const { t } = useTranslation()
  const ready = !!agent
  const busy = starting || agentLoading
  const agentName =
    agent?.displayName ?? t('chat.localAgentWelcome.fallbackName', '本机 Agent')

  const statusSub = agentLoading
    ? t('chat.localAgentWelcome.statusSubLoading', '● checking…')
    : ready
      ? t('chat.localAgentWelcome.statusSubOnline', '● online · local · ai')
      : t('chat.localAgentWelcome.statusSubOffline', '● offline · local')

  if (agentLoading && !agent) {
    return (
      <div className="flex w-full justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-full text-center">
      <p className="text-[30px] font-medium leading-relaxed tracking-tight text-ink-2">
        {ready ? (
          <span className="inline-flex items-center justify-center">
            <span>
              <span className="font-bold text-foreground">{agentName}</span>{' '}
              {t('chat.localAgentWelcome.headlineSuffix', '在本机等你开口')}
            </span>
            <BlinkCursor />
          </span>
        ) : (
          t('chat.localAgentWelcome.headlineOffline', '本机 Agent 暂不可用')
        )}
      </p>

      <p className="mt-6 font-mono text-[13px] text-faint">{statusSub}</p>

      <div className="mt-4 flex flex-nowrap items-center justify-center gap-x-4 whitespace-nowrap">
        {ready ? (
          <>
            <TextLink primary disabled={busy} onClick={onStartConversation}>
              {starting ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  {t('chat.newChat', 'New Chat')}
                </span>
              ) : (
                <>
                  {t('chat.newChat', 'New Chat')}{' '}
                  <span className="font-mono text-[12px] font-normal">⌘N</span>
                </>
              )}
            </TextLink>
            {/* {QUICK_ACTIONS.map((action) => (
              <TextLink
                key={action.labelKey}
                disabled={busy}
                title={t(action.labelKey, action.labelDefault)}
                onClick={() =>
                  onQuickAction(t(action.messageKey, action.messageDefault))
                }
              >
                {t(action.shortLabelKey, action.shortLabelDefault)}
              </TextLink>
            ))} */}
            <SessionContinueBanner
              actorId={agent.id}
              actorName={agent.displayName}
              variant="inline"
              className="shrink-0 text-[14px]"
            />
          </>
        ) : (
          <TextLink primary onClick={onOpenAgentSettings}>
            {t('chat.openAgentSettings', '打开 Agent 设置')}
          </TextLink>
        )}
      </div>
    </div>
  )
}
