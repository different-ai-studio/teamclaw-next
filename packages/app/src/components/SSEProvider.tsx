/**
 * SSEProvider — manages the OpenCode SSE connection at the app level.
 *
 * This component MUST live outside the spotlight/main mode conditional in App.tsx
 * so the SSE connection persists across mode switches. Previously, SSE was inside
 * ChatPanel which gets unmounted in spotlight mode, breaking streaming.
 */
import { useEffect, useRef } from 'react'
import { useSessionStore } from '@/stores/session'
import { useWorkspaceStore } from '@/stores/workspace'
import { useStreamingStore } from '@/stores/streaming'
import { useOpenCodeSSE } from '@/lib/opencode/sdk-sse'
import { loadPermissionConfigCache } from '@/stores/session-permissions'

export function SSEProvider() {
  // @ts-expect-error Phase 1E removal
  const activeSessionId = useSessionStore(s => s.activeSessionId)
  const workspacePath = useWorkspaceStore(s => s.workspacePath)
  const openCodeUrl = useWorkspaceStore(s => s.openCodeUrl)

  // Pre-load permission config cache so it's available synchronously
  useEffect(() => {
    if (workspacePath) loadPermissionConfigCache()
  }, [workspacePath])

  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Actions via getState() — stable refs, no subscriptions
  const acts = useSessionStore.getState()

  useOpenCodeSSE(openCodeUrl ?? "", activeSessionId, {
    // @ts-expect-error Phase 1E removal
    onMessageCreated: acts.handleMessageCreated,
    // @ts-expect-error Phase 1E removal
    onMessagePartCreated: acts.handleMessagePartCreated,
    // @ts-expect-error Phase 1E removal
    onMessagePartUpdated: acts.handleMessagePartUpdated,
    // @ts-expect-error Phase 1E removal
    onMessageCompleted: acts.handleMessageCompleted,
    // @ts-expect-error Phase 1E removal
    onToolExecuting: acts.handleToolExecuting,
    // @ts-expect-error Phase 1E removal
    onPermissionAsked: acts.handlePermissionAsked,
    // @ts-expect-error Phase 1E removal
    onQuestionAsked: acts.handleQuestionAsked,
    // @ts-expect-error Phase 1E removal
    onTodoUpdated: acts.handleTodoUpdated,
    // @ts-expect-error Phase 1E removal
    onSessionDiff: acts.handleSessionDiff,
    // @ts-expect-error Phase 1E removal
    onFileEdited: (e) => acts.handleFileEdited(e.file),
    // @ts-expect-error Phase 1E removal
    onSessionError: acts.handleSessionError,
    // @ts-expect-error Phase 1E removal
    onSessionCreated: acts.handleSessionCreated,
    // @ts-expect-error Phase 1E removal
    onSessionUpdated: acts.handleSessionUpdated,
    // @ts-expect-error Phase 1E removal
    onExternalMessage: acts.handleExternalMessage,
    // @ts-expect-error Phase 1E removal
    onSessionStatus: acts.handleSessionStatus,
    // @ts-expect-error Phase 1E removal
    onSessionBusy: acts.handleSessionBusy,
    // @ts-expect-error Phase 1E removal
    onSessionIdle: acts.handleSessionIdle,
    // @ts-expect-error Phase 1E removal
    onChildSessionEvent: acts.handleChildSessionEvent,
    onConnected: () => {
      if (disconnectTimerRef.current) {
        clearTimeout(disconnectTimerRef.current)
        disconnectTimerRef.current = null
      }
      // @ts-expect-error Phase 1E removal
      acts.setConnected(true)

      // Auto-recovery: if SSE reconnects while we're expecting a response,
      // events may have been lost during the disconnect gap.
      // Auto-reload messages to recover any missed responses.
      const { streamingMessageId } = useStreamingStore.getState()
      if (streamingMessageId) {
        console.log('[SSE] Reconnected with active streaming, auto-reloading messages:', streamingMessageId)
        // @ts-expect-error Phase 1E removal
        acts.reloadActiveSessionMessages()
      }
    },
    onDisconnected: () => {
      if (!disconnectTimerRef.current) {
        disconnectTimerRef.current = setTimeout(() => {
          // @ts-expect-error Phase 1E removal
          acts.setConnected(false)
          disconnectTimerRef.current = null
        }, 3000)
      }
    },
    // @ts-expect-error Phase 1E removal
    onError: (e) => acts.setError(e.message),
    // @ts-expect-error Phase 1E removal
    onInactivityWarning: (active) => acts.setInactivityWarning(active),
  }, workspacePath)

  // Clean up disconnect debounce timer on unmount
  useEffect(() => {
    return () => {
      if (disconnectTimerRef.current) {
        clearTimeout(disconnectTimerRef.current)
      }
    }
  }, [])

  return null
}
