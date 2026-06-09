import {
  useEffect,
  useState,
  useRef,
  MouseEvent as ReactMouseEvent,
  type ComponentType,
} from "react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Toaster, toast } from "sonner";
import { cn, isTauri, removeStartupSkeleton } from "@/lib/utils";
import { buildConfig } from "@/lib/build-config";
import { markStartup } from "@/lib/startup-perf";
import {
  BookOpen,
  FolderGit,
  ChevronLeft,
  X,
  Loader2,
  RotateCw,
  MessageSquarePlus,
  AppWindow,
  Users,
  TerminalSquare,
} from "lucide-react";
import { FileContentViewer } from "@/components/FileEditor";
import {
  useWorkspaceInit,
  useChannelGatewayInit,
  useGitReposInit,
  useCronInit,
  useWorkspaceRuntimeRefreshPoll,
  useOpenCodePreload,

  useExternalLinkHandler,
  useTauriBodyClass,
  useSetupGuide,
  useTelemetryConsent,
} from "@/hooks/useAppInit";
import {
  useDesktopNotifications,
  getDispatcher,
} from "@/hooks/useDesktopNotifications";
import {
  usePanelAutoOpen,
  useFileTabSync,
  useResizablePanels,
} from "@/hooks/useFileEditorState";
import { useMCPFileWatcher } from "@/hooks/useMCPFileWatcher";

import { AppSidebar } from "@/components/app-sidebar";
import { SidebarSecondColumn } from "@/components/sidebar/SidebarSecondColumn";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { NewSessionDialog } from "@/components/chat/NewSessionDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { UpdateDialogContainer } from "@/components/updater/UpdateDialog";
import { RightPanel } from "@/components/panel";
import { Settings } from "@/components/settings";
import { FeedbackDialog } from "@/components/settings/FeedbackDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SetupGuide } from "@/components/SetupGuide";
import { WelcomeScreen } from "@/components/auth/WelcomeScreen";
import { hasSeenWelcome, markWelcomeSeen } from "@/stores/deps";
import { TelemetryConsentDialog } from "@/components/telemetry/TelemetryConsentDialog";
import { WorkspacePrompt } from "@/components/workspace";
import { RuntimeRefreshWorkspaceBanner } from "@/components/workspace/RuntimeRefreshBanner";
import { useSessionStore } from "@/stores/session";
import { useSessionListStore } from "@/stores/session-list-store";
import { useSessionMessageStore } from "@/stores/session-message-store";
import { useSessionParticipantStore } from "@/stores/session-participant-store";
import { useSessionSelectionStore } from "@/stores/session-selection-store";
import { useAuthStore } from "@/stores/auth-store";
import { mqttConnect, mqttSubscribe, listenForEnvelopes } from "@/lib/mqtt-bridge";
import { mqttConnectionKey } from "@/lib/mqtt-connection-key";
import { useMqttReconnectStore } from "@/stores/mqtt-reconnect";
import { getEffectiveServerConfig } from "@/lib/server-config";
import { initTeamclawRpc, disposeTeamclawRpc } from "@/lib/teamclaw-rpc";
import {
  decodeLiveEvent,
  sessionIdFromLiveEvent,
  streamActorIdFromLiveEvent,
} from "@/lib/teamclaw-events";
import { handleAcpPermissionRequest } from "@/lib/teamclaw/handle-acp-permission-request";
import { handleInboxEnvelope } from "@/lib/inbox-handler";
import {
  bumpSessionListLastMessage,
  messageKindUpdatesSessionPreview,
} from "@/lib/session-list-preview";
import { executeAgentTurnFlush } from "@/lib/agent-turn-flush";
import {
  cloneStreamEntrySnapshot,
  resolveStreamEntryForPersist,
  syncStreamingToolOutputsFromLocalCache,
} from "@/lib/streaming-persist";
import {
  logInterruptMsgDiag,
  summarizeFlushDecision,
  summarizePendingReplies,
  summarizeStreamEntry,
} from "@/lib/interrupt-msg-diag";
import { logStreamToolDiag } from "@/lib/stream-tool-diag";
import { useOutboxStore } from "@/stores/outbox-store";
import { startOutboxSender } from "@/services/outbox-sender";
import { useAcpDebugStore } from "@/stores/acp-debug-store";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { initRuntimeStateStore, disposeRuntimeStateStore } from "@/stores/runtime-state-store";
import { initActorPresenceStore, disposeActorPresenceStore } from "@/stores/actor-presence-store";
import { getBackend } from "@/lib/backend";
import { getVersion } from "@tauri-apps/api/app";
import { getDesktopDeviceId } from "./lib/backend/cloud-api/device-id";
import { create as createMessage } from "@bufbuild/protobuf";
import { MessageSchema, MessageKind, type Message as TeamclawMessage } from "@/lib/proto/teamclaw_pb";
import {
  agentStreamKey,
  buildInterruptedStreamAnchor,
  isAgentActiveStatus,
  isTerminalAgentStatus,
  isToolOnlyTurnAnchor,
  mergePendingAgentReplies,
  normalizeToolResultEvent,
  normalizeToolUseEvent,
  registerDiscardPendingStreamReply,
  rememberLiveEventId,
  streamEntryHasVisibleContent,
} from "@/lib/live-agent-stream";
import {
  mapAcpPlanEntries,
  syncPlanFromTodoTool,
  syncPlanFromTodoToolResult,
} from "@/lib/sync-plan-from-todowrite";
import { useUIStore } from "@/stores/ui";
import { useWorkspaceStore } from "@/stores/workspace";
import { useLocalStatsStore } from "@/stores/local-stats";
import { useTabsStore, selectActiveTab, selectHasHiddenTabs } from "@/stores/tabs";
import { useTerminalStore } from "@/stores/terminal-store";
import { TabBar } from "@/components/tab-bar/TabBar";
import { TabContentRenderer } from "@/components/tab-bar/TabContentRenderer";
import { WebViewToolbar } from "@/components/tab-bar/WebViewToolbar";
import { FindInPageBar } from "@/components/tab-bar/FindInPageBar";
import { urlToLabel } from "@/lib/webview-utils";
import { create } from "zustand";
import {
  upsertMessagesBatch,
  type MessageRow,
} from "@/lib/local-cache";
import { syncActorsForTeam } from "@/lib/sync/actor-sync";
import { syncIdeasForTeam } from "@/lib/sync/idea-sync";
import { syncMessagesForSession } from "@/lib/sync/message-sync";
import { syncSessionsForTeam } from "@/lib/sync/session-sync";
import { Button } from "@/components/ui/button";
import { onOpenUrl, getCurrent } from "@tauri-apps/plugin-deep-link";
import { parseInviteDeeplink, claimInviteToken } from "@/lib/invite-deeplink";
import { useCurrentTeamStore } from "@/stores/current-team";
import { resolveCurrentMemberActorId } from "@/lib/current-actor";
import { installV2E2EControl, isV2E2EControlActive } from "@/lib/e2e/v2-control";
import {
  ensureSessionLiveSubscribed,
  ensureTeamSessionLiveSubscribed,
  hasTeamSessionLiveSubscription,
  resetSessionLiveSubscriptionState,
} from "@/lib/session-live-subscriptions";
import { TrafficLights } from "@/components/ui/traffic-lights";
import {
  SidebarInset,
  SidebarProvider,
  useSidebar,
} from "@/components/ui/sidebar";

export { ensureSessionLiveSubscribed } from "@/lib/session-live-subscriptions";

/** How many most-recent sessions get auto-subscribed on boot / list reload.
 * Older sessions subscribe lazily when the user opens them (see the
 * activeSessionId effect in AppContent). */
const RECENT_SESSION_SUBSCRIBE_CAP = 10;
// ── Webview UI micro-store (find bar + zoom levels) ────────────────────────
const useWebviewUIStore = create<{
  showFind: boolean
  zoomLevels: Record<string, number>
  setShowFind: (v: boolean) => void
  setZoomLevel: (label: string, level: number) => void
}>((set, get) => ({
  showFind: false,
  zoomLevels: {},
  setShowFind: (v) => set({ showFind: v }),
  setZoomLevel: (label, level) =>
    set({ zoomLevels: { ...get().zoomLevels, [label]: level } }),
}))

/**
 * Global keyboard shortcuts (Cmd+F, Cmd+/-/0) and context menu listener
 * for webview tabs. Registered once, reads active tab from tabs store.
 */
function useWebviewShortcuts() {
  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      const activeTab = useTabsStore.getState().getActiveTab()
      if (!activeTab || activeTab.type !== "webview") return
      if (!isTauri()) return

      const mod = e.metaKey || e.ctrlKey
      const webviewLabel = urlToLabel(activeTab.target)
      const { setShowFind, setZoomLevel, zoomLevels } =
        useWebviewUIStore.getState()

      if (mod && e.key === "f") {
        e.preventDefault()
        setShowFind(true)
        return
      }

      if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault()
        const cur = zoomLevels[webviewLabel] ?? 1.0
        const next = Math.min(Math.round((cur + 0.1) * 10) / 10, 2.0)
        setZoomLevel(webviewLabel, next)
        import("@tauri-apps/api/core").then(({ invoke }) => {
          invoke("webview_set_zoom", { label: webviewLabel, level: next }).catch(
            () => {}
          )
        })
        return
      }

      if (mod && e.key === "-") {
        e.preventDefault()
        const cur = zoomLevels[webviewLabel] ?? 1.0
        const next = Math.max(Math.round((cur - 0.1) * 10) / 10, 0.5)
        setZoomLevel(webviewLabel, next)
        import("@tauri-apps/api/core").then(({ invoke }) => {
          invoke("webview_set_zoom", { label: webviewLabel, level: next }).catch(
            () => {}
          )
        })
        return
      }

      if (mod && e.key === "0") {
        e.preventDefault()
        setZoomLevel(webviewLabel, 1.0)
        import("@tauri-apps/api/core").then(({ invoke }) => {
          invoke("webview_set_zoom", {
            label: webviewLabel,
            level: 1.0,
          }).catch(() => {})
        })
        return
      }
    }

    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [])
}

function useTerminalShortcuts() {
  const togglePanel = useTerminalStore(s => s.togglePanel);
  const openTerminal = useTerminalStore(s => s.openTerminal);
  const closeTerminal = useTerminalStore(s => s.closeTerminal);
  const workspacePath = useWorkspaceStore(s => s.workspacePath);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!workspacePath) return;
      const mod = e.metaKey || e.ctrlKey;

      // Ctrl + ` (backtick) — toggle terminal panel
      if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        togglePanel(workspacePath);
        return;
      }

      // Only act on Cmd+T / Cmd+W when focus is inside a terminal viewport.
      const focused = document.activeElement;
      const inTerminal = focused?.closest?.(".xterm") != null;
      if (!inTerminal) return;

      if (mod && e.key.toLowerCase() === "t") {
        e.preventDefault();
        void openTerminal(workspacePath, {
          cwd: workspacePath,
          allowedRoots: [workspacePath],
        });
        return;
      }

      if (mod && e.key.toLowerCase() === "w") {
        e.preventDefault();
        const state = useTerminalStore.getState();
        const activeId = state.activeTabByWorkspace[workspacePath];
        if (activeId) void closeTerminal(activeId);
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [workspacePath, togglePanel, openTerminal, closeTerminal]);
}

// Main content component - shows chat with tab overlay
// ChatPanel is always mounted to preserve state, hidden when a tab is active
function MainContent() {
  const activeTab = useTabsStore(selectActiveTab);
  const mainContentLayout = useUIStore((s) => s.mainContentLayout);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const [splitContainerWidth, setSplitContainerWidth] = useState(0);
  const mainSplitLeftMaxWidth =
    splitContainerWidth > 0 ? Math.max(360, splitContainerWidth - 280) : undefined;
  const { mainSplitLeftWidth, handleMainSplitResize } = useResizablePanels({
    mainSplitLeftMaxWidth,
  });
  const selectedFile = useWorkspaceStore((s) => s.selectedFile);
  const fileContent = useWorkspaceStore((s) => s.fileContent);
  const isLoadingFile = useWorkspaceStore((s) => s.isLoadingFile);
  const clearSelection = useWorkspaceStore((s) => s.clearSelection);
  const selectFile = useWorkspaceStore((s) => s.selectFile);
  const showFind = useWebviewUIStore((s) => s.showFind)
  const zoomLevels = useWebviewUIStore((s) => s.zoomLevels)
  const hasActiveTab = !!activeTab;

  // Track previous active tab to detect tab switches (user clicking a different tab)
  const prevActiveTabId = useRef<string | null>(activeTab?.id ?? null);

  // Sync workspace store when user switches tabs (tab click → load file)
  useEffect(() => {
    const tabChanged = activeTab?.id !== prevActiveTabId.current;
    const hadTab = prevActiveTabId.current !== null;
    prevActiveTabId.current = activeTab?.id ?? null;
    if (tabChanged && activeTab?.type === "file") {
      selectFile(activeTab.target);
    }
    // When active file tab is closed (had a tab → now null), clear selectedFile
    // to prevent stale file re-opening on mode switch
    if (tabChanged && hadTab && !activeTab) {
      clearSelection();
    }
  }, [activeTab?.id, activeTab?.type, activeTab?.target, selectFile, clearSelection]);

  // Sync file selections to tab store (file opened from chat links, file tree, etc.)
  useEffect(() => {
    if (selectedFile) {
      const filename = selectedFile.split("/").pop() || selectedFile;
      useTabsStore.getState().openTab({
        type: "file",
        target: selectedFile,
        label: filename,
      });
    }
  }, [selectedFile]);

  useEffect(() => {
    if (mainContentLayout !== "split") return;
    const container = splitContainerRef.current;
    if (!container) return;

    const updateWidth = () => {
      setSplitContainerWidth(container.getBoundingClientRect().width);
    };

    updateWidth();

    const observer = new ResizeObserver(() => {
      updateWidth();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, [mainContentLayout]);

  const fileArea = (
    <div className="relative h-full flex flex-col">
      <TabBar />
      {hasActiveTab && activeTab.type === "webview" && (
        <WebViewToolbar
          url={activeTab.target}
          label={urlToLabel(activeTab.target)}
          zoomLevel={zoomLevels[urlToLabel(activeTab.target)]}
        />
      )}
      {hasActiveTab && activeTab.type === "webview" && showFind && (
        <FindInPageBar
          label={urlToLabel(activeTab.target)}
          onClose={() => useWebviewUIStore.getState().setShowFind(false)}
        />
      )}
      <div className="relative flex-1">
        {hasActiveTab ? (
          <div className={cn(
            "absolute inset-0",
            activeTab.type === "webview" ? "bg-transparent pointer-events-none" : "bg-background"
          )}>
            {activeTab.type === "file" ? (
              <FileContentViewer
                selectedFile={selectedFile}
                fileContent={fileContent}
                isLoadingFile={isLoadingFile}
                onClose={() => {
                  clearSelection();
                  useTabsStore.getState().closeTab(activeTab.id);
                }}
              />
            ) : (
              <TabContentRenderer />
            )}
          </div>
        ) : (
          mainContentLayout === "split" ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select a file or web tab
            </div>
          ) : null
        )}
      </div>
    </div>
  );

  if (mainContentLayout === "split") {
    return (
      <div
        ref={splitContainerRef}
        className="flex h-full min-h-0 overflow-hidden bg-background"
        data-testid="main-content-split"
      >
        <div
          className="min-w-0 shrink-0 overflow-hidden border-r border-border bg-background"
          style={{ width: mainSplitLeftWidth }}
        >
          {fileArea}
        </div>
        <ResizeHandle
          onResize={handleMainSplitResize}
          className="bg-border/60 hover:bg-primary/50"
          testId="main-content-split-resize-handle"
        />
        <div className="relative min-w-0 flex-1 overflow-hidden bg-background">
          <ErrorBoundary scope="Chat" inline>
            <ChatPanel />
          </ErrorBoundary>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full flex flex-col">
      {fileArea}
      <div className={`absolute inset-0 ${hasActiveTab ? "invisible" : "visible"}`}>
        <ErrorBoundary scope="Chat" inline>
          <ChatPanel />
        </ErrorBoundary>
      </div>
    </div>
  );
}

// Terminal toggle button in header
function TerminalToggleButton({ workspacePath }: { workspacePath: string }) {
  const { t } = useTranslation();
  const terminalOpen = useTerminalStore(
    s => Boolean(s.panelOpenByWorkspace[workspacePath]),
  );
  const togglePanel = useTerminalStore(s => s.togglePanel);
  return (
    <button
      className={cn(
        "ml-1 rounded p-1 transition-colors hover:bg-muted hover:text-foreground",
        terminalOpen ? "bg-muted text-foreground" : "text-muted-foreground",
      )}
      onClick={() => togglePanel(workspacePath)}
      title={t("terminal.toggle", "Toggle terminal (⌃`)")}
    >
      <TerminalSquare className="h-4 w-4" />
    </button>
  );
}

// Header panel tab button component
function HeaderPanelTab({
  icon: Icon,
  label,
  count,
  isActive,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  count?: number;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex items-center gap-1.5 px-2 py-1 text-xs transition-colors rounded ${
        isActive
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-muted"
      }`}
      onClick={onClick}
    >
      <Icon className="h-4 w-4" />
      {isActive && <span>{label}</span>}
      {!!count && count > 0 && (
        <span
          className={`min-w-[1.25rem] h-5 px-1 rounded-full text-[10px] font-medium flex items-center justify-center ${
            isActive ? "bg-primary/20 text-primary" : "bg-muted-foreground/20"
          }`}
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </button>
  );
}

// Resize handle component for resizable panels
function ResizeHandle({
  onResize,
  direction = "horizontal",
  className = "",
  testId,
}: {
  onResize: (delta: number) => void;
  direction?: "horizontal" | "vertical";
  className?: string;
  testId?: string;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const startPosRef = useRef(0);

  const handleMouseDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    startPosRef.current = direction === "horizontal" ? e.clientX : e.clientY;

    const handleMouseMove = (moveEvent: globalThis.MouseEvent) => {
      const currentPos =
        direction === "horizontal" ? moveEvent.clientX : moveEvent.clientY;
      const delta = currentPos - startPosRef.current;
      startPosRef.current = currentPos;
      onResize(delta);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor =
      direction === "horizontal" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div
      className={`
        ${direction === "horizontal" ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize"}
        ${isDragging ? "bg-primary" : "bg-transparent hover:bg-primary/50"}
        transition-colors duration-150 flex-shrink-0 z-20
        ${className}
      `}
      data-testid={testId}
      onMouseDown={handleMouseDown}
    >
      {/* Larger hit area */}
      <div
        className={`
          ${direction === "horizontal" ? "w-3 h-full -ml-1" : "h-3 w-full -mt-1"}
        `}
      />
    </div>
  );
}


// Inner component to access sidebar context
function AppContent() {
  const { t } = useTranslation();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // Session store - individual selectors. Note: we subscribe to the
  // *result* of getActiveSession() so re-renders fire when currentSessionId
  // / sessions change. Subscribing to the function ref alone never
  // re-renders since the ref is stable.
  const activeSession = useSessionStore((s) => s.getActiveSession());
  const sessionDiff = useSessionStore((s) => s.sessionDiff);
  const reloadActiveSessionMessages = useSessionStore(
    (s) => s.reloadActiveSessionMessages,
  );

  // Workspace store - individual selectors
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const isPanelOpen = useWorkspaceStore((s) => s.isPanelOpen);
  const activeTab = useWorkspaceStore((s) => s.activeTab);
  const openPanel = useWorkspaceStore((s) => s.openPanel);
  const closePanel = useWorkspaceStore((s) => s.closePanel);

  // UI store - individual selectors
  const currentView = useUIStore((s) => s.currentView);
  const closeSettings = useUIStore((s) => s.closeSettings);
  const authSession = useAuthStore((s) => s.session);
  const loadCurrentTeam = useCurrentTeamStore((s) => s.load);
  const mainContentLayout = useUIStore((s) => s.mainContentLayout);
  const { state, open: sidebarOpen, setOpen: setSidebarOpen } = useSidebar();
  const hasActiveFileTab = !!useTabsStore(selectActiveTab);
  const hasHiddenTabs = useTabsStore(selectHasHiddenTabs);
  /** Shortcuts open in the left dock for both shells.
   * Only the workspace shell temporarily replaces the sidebar with that dock.
   * Knowledge pops out from the right (via the top-right Knowledge icon). */
  const leftDockActive =
    isPanelOpen &&
    activeTab === "shortcuts";
  const showRightWorkspacePanel = isPanelOpen && !leftDockActive;
  const settingsOpen = currentView === "settings";

  useEffect(() => {
    void loadCurrentTeam();
  }, [authSession?.user.id, loadCurrentTeam]);

  // In workspace mode, SessionListColumn always sits to the left of SidebarInset
  // and renders its own traffic-light + collapse strip when the sidebar is
  // closed, so the chat header should NOT re-render that strip there.
  const collapsedInsetLeading = null;
  const [isRefreshingMessages, setIsRefreshingMessages] = useState(false);
  // Resolved by the MQTT-connect effect; passed to the notification dispatcher.
  const [myActorId, setMyActorId] = useState<string | null>(null);
  // Extracted hooks — initialization, panel state, keyboard shortcuts
  const { initialWorkspaceResolved, openCodeError } = useWorkspaceInit();
  const daemonHttpReady = useWorkspaceStore((s) => s.daemonHttpReady);

  // Surface a local amuxd daemon connection failure as a persistent toast
  // instead of taking over the whole window. The rest of the UI stays usable;
  // the toast auto-dismisses once the daemon becomes reachable.
  useEffect(() => {
    const DAEMON_TOAST_ID = "amuxd-daemon-unavailable";
    if (isTauri() && workspacePath && !daemonHttpReady && openCodeError) {
      toast.error(openCodeError, {
        id: DAEMON_TOAST_ID,
        duration: Infinity,
        description: t(
          "workspace.daemonUnavailableHint",
          "Start amuxd on this machine (e.g. pnpm daemon:run), confirm the HTTP port/token files exist under ~/.amuxd/, then retry.",
        ),
        action: {
          label: t("common.retry", "Retry"),
          onClick: () => window.location.reload(),
        },
      });
    } else {
      toast.dismiss(DAEMON_TOAST_ID);
    }
  }, [workspacePath, daemonHttpReady, openCodeError, t]);

  useDesktopNotifications(myActorId);
  useChannelGatewayInit();
  useGitReposInit();
  useCronInit();
  useWorkspaceRuntimeRefreshPoll();
  useMCPFileWatcher(workspacePath);
  useExternalLinkHandler();
  usePanelAutoOpen();
  useFileTabSync();

  // v2 Phase 1: load session list from Supabase once AppContent mounts
  // (i.e. after auth is verified). Phase 2 will replace with realtime sub.
  useEffect(() => {
    if (isV2E2EControlActive()) return;
    void useSessionListStore.getState().load();
  }, []);

  // Hand off from the static #skeleton the moment the workspace resolves — to
  // real three-column content (workspacePath set) or the workspace picker
  // (none). AuthGate keeps the skeleton up through every loading gate and lets
  // App own the final removal, so the cold-start hand-off is skeleton → real UI
  // with no intermediate blank or spinner. Also stamp first-content for the perf
  // timeline on the happy path.
  useEffect(() => {
    if (!initialWorkspaceResolved) return;
    removeStartupSkeleton();
    if (workspacePath) markStartup("first-content");
  }, [initialWorkspaceResolved, workspacePath]);

  // Boot the outbox: hydrate any pending/failed rows from libsql so a
  // crashed/closed app resumes in-flight sends, then start the sender loop
  // (idempotent). `startOutboxSender` schedules a tick every second; the
  // first tick fires immediately after hydration.
  useEffect(() => {
    void (async () => {
      await useOutboxStore.getState().hydrate();
      startOutboxSender();
    })();
  }, []);

  // v2 Phase 1 — Task 1D.4: connect MQTT after auth, subscribe to all teams'
  // session live topics, decode incoming LiveEventEnvelope and append to
  // useSessionStore so ActorMessageList re-renders. The orphan
  // session-event-bus.ts is bypassed: we write straight to the store the UI
  // reads from.
  const userId = useAuthStore((s) => s.session?.user.id ?? null);
  // Wait for a team id for MQTT ACL. The active team from settings is the
  // authoritative source — populated by AuthGate / loadCurrentTeam after login.
  const currentTeamId = useCurrentTeamStore((s) => s.team?.id ?? null);

  // Report this desktop install's tauri client version once per team selection.
  useEffect(() => {
    if (!currentTeamId) return;
    let cancelled = false;
    void (async () => {
      let version: string;
      try {
        version = await getVersion(); // throws outside Tauri (web preview) — skip then
      } catch {
        return;
      }
      if (cancelled) return;
      await getBackend().telemetry.reportClientVersion(currentTeamId, {
        clientType: "tauri",
        version,
        deviceId: getDesktopDeviceId(),
        build: null,
      });
    })();
    return () => { cancelled = true; };
  }, [currentTeamId]);

  const mqttTeamId = currentTeamId;
  const mqttAccessToken = useAuthStore((s) => s.session?.access_token ?? null);
  const mqttReconnectNonce = useMqttReconnectStore((s) => s.nonce);
  const mqttAuthKey = mqttConnectionKey({
    userId,
    teamId: mqttTeamId,
    accessToken: mqttAccessToken,
  });
  const pendingStreamRepliesRef = useRef<Record<string, TeamclawMessage[]>>({});
  /** Set on terminal statusChange; late message.created triggers flush. */
  const terminalFlushPendingRef = useRef<Record<string, boolean>>({});
  const seenLiveEventIdsRef = useRef<Set<string>>(new Set());

  function clearTurnAgentReplyParking(streamKey: string) {
    delete pendingStreamRepliesRef.current[streamKey];
  }

  function clearTerminalFlushPending(streamKey: string) {
    delete terminalFlushPendingRef.current[streamKey];
  }

  const flushTurnAgentReplyInFlightRef = useRef<Record<string, boolean>>({});
  /** Eager client flush when terminal arrives before daemon agent_reply (interrupt + tool). */
  const interruptedStreamFlushRef = useRef<
    Record<string, { streamId: string; messageId: string }>
  >({});

  function removeInterruptedStreamPlaceholder(
    sessionId: string,
    actorId: string,
    streamId: string | undefined,
  ) {
    const streamKey = agentStreamKey(sessionId, actorId);
    const placeholder = interruptedStreamFlushRef.current[streamKey];
    if (!placeholder || !streamId || placeholder.streamId !== streamId) return;
    useSessionMessageStore
      .getState()
      .removeMessageById(sessionId, placeholder.messageId);
    delete interruptedStreamFlushRef.current[streamKey];
  }

  function teamIdForSession(sessionId: string): string {
    return (
      useSessionListStore.getState().rows.find((r) => r.id === sessionId)
        ?.team_id ?? ""
    );
  }

  function flushInterruptedStreamArtifacts(
    sessionId: string,
    actorId: string,
    trigger: string,
  ): boolean {
    const streamKey = agentStreamKey(sessionId, actorId);
    if (flushTurnAgentReplyInFlightRef.current[streamKey]) {
      logInterruptMsgDiag("flush.interrupted.skip.inFlight", {
        sessionId,
        actorId,
        trigger,
      });
      return false;
    }

    const liveStreamEntry = useV2StreamingStore.getState().byKey[streamKey];
    const streamEntryForPersist = resolveStreamEntryForPersist(
      sessionId,
      actorId,
      liveStreamEntry,
    );
    if (!streamEntryForPersist || !streamEntryHasVisibleContent(streamEntryForPersist)) {
      return false;
    }

    const snapshot = cloneStreamEntrySnapshot(streamEntryForPersist);
    const existing = interruptedStreamFlushRef.current[streamKey];
    if (existing?.streamId === snapshot.streamId) {
      logInterruptMsgDiag("flush.interrupted.skip.already", {
        sessionId,
        actorId,
        trigger,
        streamId: snapshot.streamId,
        messageId: existing.messageId,
      });
      return true;
    }

    const syntheticReply = buildInterruptedStreamAnchor(
      sessionId,
      actorId,
      snapshot,
    );
    logInterruptMsgDiag("flush.interrupted.start", {
      sessionId,
      actorId,
      trigger,
      streamId: snapshot.streamId,
      messageId: syntheticReply.messageId,
      ...summarizeStreamEntry(snapshot, "snapshot"),
    });

    flushTurnAgentReplyInFlightRef.current[streamKey] = true;
    const streamEntrySnapshot = snapshot;
    useV2StreamingStore
      .getState()
      .detachLiveStreamForPersist(sessionId, actorId, snapshot.streamId);

    void executeAgentTurnFlush({
      sessionId,
      actorId,
      trigger,
      teamId: teamIdForSession(sessionId),
      reply: syntheticReply,
      pendingReplies: [],
      streamEntrySnapshot,
      persistedStage: "flush.interrupted.persisted",
      afterEnriched: (enrichedReply) => {
        interruptedStreamFlushRef.current[streamKey] = {
          streamId: snapshot.streamId,
          messageId: enrichedReply.messageId,
        };
      },
    }).finally(() => {
      delete flushTurnAgentReplyInFlightRef.current[streamKey];
      useV2StreamingStore
        .getState()
        .clearInterruptedFlushPending(sessionId, actorId);
    });

    return true;
  }

  function flushTurnAgentReply(
    sessionId: string,
    actorId: string,
    trigger = "unknown",
  ): boolean {
    const streamKey = agentStreamKey(sessionId, actorId);
    if (flushTurnAgentReplyInFlightRef.current[streamKey]) {
      logInterruptMsgDiag("flush.skip.inFlight", { sessionId, actorId, trigger });
      return false;
    }

    const pendingReplies = pendingStreamRepliesRef.current[streamKey];
    if (!pendingReplies?.length) {
      logInterruptMsgDiag("flush.skip.noPending", {
        sessionId,
        actorId,
        trigger,
        terminalFlushPending: Boolean(terminalFlushPendingRef.current[streamKey]),
        ...summarizeStreamEntry(
          useV2StreamingStore.getState().byKey[streamKey],
          "live",
        ),
        archivedCount: useV2StreamingStore.getState().archived.filter(
          (entry) => entry.sessionId === sessionId && entry.actorId === actorId,
        ).length,
      });
      return false;
    }

    const liveStreamEntry = useV2StreamingStore.getState().byKey[streamKey];
    const streamEntryForPersist = resolveStreamEntryForPersist(
      sessionId,
      actorId,
      liveStreamEntry,
    );
    const flushDecision = summarizeFlushDecision({
      pending: pendingReplies,
      liveStream: liveStreamEntry,
      resolvedStream: streamEntryForPersist,
    });
    const mergedReply = mergePendingAgentReplies(
      pendingReplies,
      streamEntryForPersist,
    );
    if (!mergedReply) {
      logInterruptMsgDiag("flush.skip.mergeNull", {
        sessionId,
        actorId,
        trigger,
        ...flushDecision,
      });
      return false;
    }

    logInterruptMsgDiag("flush.start", {
      sessionId,
      actorId,
      trigger,
      ...flushDecision,
    });
    flushTurnAgentReplyInFlightRef.current[streamKey] = true;
    const pendingSnapshot = [...pendingReplies];
    const streamEntrySnapshot = streamEntryForPersist
      ? cloneStreamEntrySnapshot(streamEntryForPersist)
      : undefined;
    clearTurnAgentReplyParking(streamKey);

    void executeAgentTurnFlush({
      sessionId,
      actorId,
      trigger,
      teamId: teamIdForSession(sessionId),
      reply: mergedReply,
      pendingReplies: pendingSnapshot,
      streamEntrySnapshot,
      beforePersist: () => {
        useV2StreamingStore.getState().finalize(sessionId, actorId);
      },
      afterEnriched: () => {
        removeInterruptedStreamPlaceholder(
          sessionId,
          actorId,
          streamEntrySnapshot?.streamId,
        );
      },
      persistedStage: "flush.persisted",
    }).finally(() => {
      delete flushTurnAgentReplyInFlightRef.current[streamKey];
      useV2StreamingStore
        .getState()
        .clearInterruptedFlushPending(sessionId, actorId);
    });

    return true;
  }

  useEffect(() => {
    registerDiscardPendingStreamReply((sessionId, actorId) => {
      const streamKey = agentStreamKey(sessionId, actorId);
      logInterruptMsgDiag("flush.discardPending", {
        sessionId,
        actorId,
        ...summarizePendingReplies(pendingStreamRepliesRef.current[streamKey]),
      });
      clearTurnAgentReplyParking(streamKey);
      clearTerminalFlushPending(streamKey);
    });
    return () => {
      registerDiscardPendingStreamReply(null);
    };
  }, []);

  useEffect(() => {
    if (!mqttAuthKey || !userId || !mqttTeamId || !mqttAccessToken) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      try {
        markStartup("mqtt:start");
        // amuxd convention: MQTT username = actor_id, password = JWT
        // (see amux/daemon/src/mqtt/client.rs + daemon/server.rs).
        // EMQX validates the JWT and uses actor_id for topic ACL.
        const actorId = await resolveCurrentMemberActorId(mqttTeamId, userId, {
          currentTeamId: useCurrentTeamStore.getState().team?.id ?? null,
          currentMemberId: useCurrentTeamStore.getState().currentMember?.id ?? null,
        });
        if (!actorId) {
          console.warn("[MQTT] no actor for user in team", mqttTeamId, "— skipping connect");
          return;
        }
        if (cancelled) return;
        setMyActorId(actorId);
        const serverConfig = await getEffectiveServerConfig();
        const brokerHost = serverConfig.mqttHost;
        const brokerPort = serverConfig.mqttPort ?? 1883;
        const useTls = serverConfig.mqttUseTls ?? false;
        if (!brokerHost) {
          console.warn("[MQTT] missing broker host — configure it in Settings > Server");
          return;
        }
        console.info("[MQTT] connecting", {
          brokerHost,
          brokerPort,
          useTls,
          teamId: mqttTeamId,
          actorId,
        });

        const configuredMqttUsername = serverConfig.mqttUsername?.trim();
        const configuredMqttPassword = serverConfig.mqttPassword?.trim();
        const useConfiguredMqttCredentials = Boolean(configuredMqttUsername && configuredMqttPassword);

        await mqttConnect({
          brokerHost,
          brokerPort,
          username: useConfiguredMqttCredentials ? configuredMqttUsername! : actorId,
          password: useConfiguredMqttCredentials ? configuredMqttPassword! : mqttAccessToken,
          clientId: `teamclaw-${actorId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
          teamId: mqttTeamId,
          useTls,
        });
        markStartup("mqtt:connected");
        resetSessionLiveSubscriptionState();
        if (cancelled) return;

        // FC fans out to inbox/<auth.user_id> (see push-dispatch.ts), not actor_id.
        try {
          await mqttSubscribe(`inbox/${userId}`);
        } catch (e) {
          console.warn("[inbox] subscribe failed", e);
        }
        if (cancelled) return;

        unlisten = await listenForEnvelopes((env) => {
          if (env.topic.startsWith("inbox/")) {
            handleInboxEnvelope(env, userId, useSessionListStore.getState());
            return;
          }
          const decoded = decodeLiveEvent(new Uint8Array(env.bytes));
          if (!decoded) return;
          const sid = sessionIdFromLiveEvent(decoded, env.topic) ?? "";

          if (
            sid &&
            env.topic.includes("/session/") &&
            !rememberLiveEventId(
              seenLiveEventIdsRef.current,
              sid,
              decoded.envelope.eventId,
            )
          ) {
            return;
          }

          if (env.topic.includes("/session/") && env.topic.endsWith("/live")) {
            const mentionActorIds =
              decoded.envelope.eventType === "message.created"
                ? decoded.sessionMessage?.mentionActorIds ?? []
                : undefined;
            useAcpDebugStore.getState().append({
              sessionId: sid,
              topic: env.topic,
              actorId: decoded.envelope.actorId,
              eventCase: `live:${decoded.envelope.eventType || "unknown"}`,
              envelopeMeta: {
                eventId: decoded.envelope.eventId,
                eventType: decoded.envelope.eventType,
                sentAt: decoded.envelope.sentAt?.toString?.() ?? "",
                actorId: decoded.envelope.actorId,
                sessionId: decoded.envelope.sessionId,
                hasAcpEvent: Boolean(decoded.acpEvent),
                acpCase: decoded.acpEvent?.event?.case ?? null,
                ...(mentionActorIds !== undefined
                  ? {
                      mentionActorIds,
                      contentPreview: decoded.sessionMessage?.message?.content?.slice(0, 80) ?? "",
                    }
                  : {}),
              },
              acpEvent: decoded.acpEvent,
            });
          }

          if (!sid) return;

          if (
            decoded.envelope.eventType === "session_participant.created" ||
            decoded.envelope.eventType === "session_participant.updated" ||
            decoded.envelope.eventType === "session_participant.deleted" ||
            decoded.envelope.eventType === "participant.added" ||
            decoded.envelope.eventType === "participant.removed" ||
            decoded.envelope.eventType === "session.participant.added" ||
            decoded.envelope.eventType === "session.participant.removed"
          ) {
            const teamId =
              useSessionListStore.getState().rows.find((r) => r.id === sid)
                ?.team_id ?? mqttTeamId;
            void useSessionParticipantStore
              .getState()
              .refreshSession(sid, teamId)
              .catch((e) => {
                console.warn("[participants] refresh failed:", e);
                useSessionParticipantStore.getState().invalidateSessions([sid]);
              });
            return;
          }

          // Case 1: final message.created
          if (decoded.message) {
            const msg = decoded.message;
            const senderActorId = msg.senderActorId;
            const streamingStore = useV2StreamingStore.getState();
            const streamKey = senderActorId ? agentStreamKey(sid, senderActorId) : "";
            const streamEntry = streamKey
              ? streamingStore.byKey[streamKey]
              : undefined;
            let parkedAgentReply = false;
            if (
              streamEntry &&
              senderActorId &&
              msg.kind === MessageKind.AGENT_REPLY
            ) {
              // Mid-turn daemon AgentReply slices stay parked until terminal
              // statusChange (or a late message.created after terminal).
              parkedAgentReply = true;
              const pendingReplies =
                pendingStreamRepliesRef.current[streamKey] ?? [];
              const nextPendingReplies = pendingReplies.some(
                (message) => message.messageId === msg.messageId,
              )
                ? pendingReplies
                : [...pendingReplies, msg];
              if (nextPendingReplies !== pendingReplies) {
                pendingStreamRepliesRef.current[streamKey] = nextPendingReplies;
              }
              const resolvedStreamEntry = resolveStreamEntryForPersist(
                sid,
                senderActorId,
                streamEntry,
              );
              const terminalPending = Boolean(
                terminalFlushPendingRef.current[streamKey],
              );
              const toolOnlyAnchor = isToolOnlyTurnAnchor(
                nextPendingReplies,
                resolvedStreamEntry,
              );
              const shouldFlush =
                terminalPending || toolOnlyAnchor;
              logInterruptMsgDiag("mqtt.agentReply.parked", {
                sessionId: sid,
                actorId: senderActorId,
                messageId: msg.messageId,
                turnId: msg.turnId,
                contentLength: (msg.content ?? "").trim().length,
                terminalPending,
                toolOnlyAnchor,
                shouldFlush,
                ...summarizeFlushDecision({
                  pending: nextPendingReplies,
                  liveStream: streamEntry,
                  resolvedStream: resolvedStreamEntry,
                }),
              });
              if (shouldFlush) {
                flushTurnAgentReply(
                  sid,
                  senderActorId,
                  terminalPending
                    ? "mqtt.message.created.terminalPending"
                    : "mqtt.message.created.toolOnlyAnchor",
                );
              }
            } else if (streamEntry && senderActorId) {
              streamingStore.finalize(
                sid,
                senderActorId,
                decoded.message.content,
              );
              useSessionMessageStore.getState().appendMessage(sid, decoded.message);
            } else {
              useSessionMessageStore.getState().appendMessage(sid, decoded.message);
            }

            if (
              !parkedAgentReply &&
              messageKindUpdatesSessionPreview(decoded.message.kind)
            ) {
              const createdAtSec = Number(decoded.message.createdAt);
              bumpSessionListLastMessage(sid, decoded.message.content, {
                at: Number.isFinite(createdAtSec) && createdAtSec > 0
                  ? new Date(createdAtSec * 1000).toISOString()
                  : undefined,
              });
            }

            // Write ALL incoming messages into the unified `message` table
            // (origin="mqtt-live"). This replaces the old agent_runtime_event
            // writes for tool-call/result/thinking kinds.
            // The insertAgentRuntimeEvent table stays alive for backwards compat
            // but is no longer the primary read path.
            // TODO(cleanup): remove insertAgentRuntimeEvent writes once all
            //   clients have upgraded past this version and the old read path
            //   in history loader above is cleaned up.
            if (!parkedAgentReply) {
              const m = decoded.message;
              const kindStr =
                m.kind === MessageKind.AGENT_TOOL_CALL
                  ? "agent_tool_call"
                  : m.kind === MessageKind.AGENT_TOOL_RESULT
                    ? "agent_tool_result"
                    : m.kind === MessageKind.AGENT_THINKING
                      ? "agent_thinking"
                      : m.kind === MessageKind.AGENT_REPLY
                        ? "agent_reply"
                        : m.kind === MessageKind.SYSTEM
                          ? "system"
                          : "text";
              const teamId =
                useSessionListStore.getState().rows.find(
                  (r) => r.id === sid,
                )?.team_id ?? "";
              const now = new Date().toISOString();
              const msgRow: MessageRow = {
                id: m.messageId,
                teamId,
                sessionId: m.sessionId,
                turnId: m.turnId || null,
                senderActorId: m.senderActorId || null,
                replyToMessageId: null,
                kind: kindStr,
                content: m.content,
                metadataJson: m.metadataJson || null,
                model: m.model || null,
                mentionsJson: null,
                origin: "mqtt-live",
                createdAt: new Date(Number(m.createdAt) * 1000).toISOString(),
                updatedAt: now,
                deletedAt: null,
                syncedAt: now,
                partsJson: (m as unknown as { partsJson?: string | null }).partsJson ?? null,
              };
              upsertMessagesBatch([msgRow]).catch((e) => {
                console.warn("[cache] message upsert failed:", e);
              });
            }
            // Desktop notification: fire-and-forget; dispatcher filters own
            // messages, DnD, focus, mute — no action needed on error.
            {
              const dm = decoded.message;
              const dmKind =
                dm.kind === MessageKind.AGENT_TOOL_CALL ? "agent_tool_call"
                : dm.kind === MessageKind.AGENT_TOOL_RESULT ? "agent_tool_result"
                : dm.kind === MessageKind.AGENT_THINKING ? "agent_thinking"
                : dm.kind === MessageKind.AGENT_REPLY ? "agent_reply"
                : dm.kind === MessageKind.SYSTEM ? "system"
                : "text";
              getDispatcher()?.maybeNotify({
                id: dm.messageId,
                session_id: dm.sessionId,
                sender_actor_id: dm.senderActorId,
                kind: dmKind,
                content: dm.content,
              }).catch((e) => {
                console.warn("[notifications] maybeNotify failed:", e);
              });
            }
            return;
          }

          // Case 2: streaming acp.event
          if (decoded.acpEvent) {
            const actorId = streamActorIdFromLiveEvent(decoded);
            if (!actorId) return;
            const event = decoded.acpEvent.event;

            // acp.event detail already logged in the live:* line above.
            if (event?.case === "output") {
              const text = (event.value as { text?: string })?.text ?? "";
              useV2StreamingStore.getState().appendOutput(sid, actorId, text);
            } else if (event?.case === "thinking") {
              const text = (event.value as { text?: string })?.text ?? "";
              useV2StreamingStore.getState().appendThinking(sid, actorId, text);
            } else if (event?.case === "toolUse") {
              const tu = normalizeToolUseEvent(event.value);
              useV2StreamingStore.getState().pushToolUse(sid, actorId, {
                toolId: tu.toolId,
                toolName: tu.toolName,
                description: tu.description,
                params: tu.params,
                toolKind: tu.toolKind,
              });
              // Capture skill invocations for local stats + cloud leaderboard.
              // tu.toolName is "skill" for Skill tool calls; tu.params.name is
              // the skill slug (e.g. "sentry-fix").
              if (tu.toolName === "skill" && tu.params?.name) {
                const wp = useWorkspaceStore.getState().workspacePath;
                if (wp) {
                  void useLocalStatsStore.getState().incrementSkillUsage(wp, tu.params.name);
                }
              }
              syncPlanFromTodoTool(sid, actorId, {
                toolName: tu.toolName,
                params: tu.params,
                description: tu.description,
              });
            } else if (event?.case === "toolResult") {
              const tr = normalizeToolResultEvent(event.value);
              logStreamToolDiag("mqtt.toolResult", {
                sessionId: sid,
                actorId,
                eventId: decoded.envelope.eventId,
                toolId: tr.toolId,
                success: tr.success,
              });
              useV2StreamingStore.getState().completeToolUse(sid, actorId, {
                toolId: tr.toolId,
                success: tr.success,
                summary: tr.summary,
              });
              syncPlanFromTodoToolResult(sid, actorId, {
                toolId: tr.toolId,
                success: tr.success,
                summary: tr.summary,
              });
              void syncStreamingToolOutputsFromLocalCache(sid, actorId);
              window.setTimeout(() => {
                void syncStreamingToolOutputsFromLocalCache(sid, actorId);
              }, 500);
            } else if (event?.case === "statusChange") {
              const sc = event.value as { oldStatus?: number; newStatus?: number };
              logStreamToolDiag("mqtt.statusChange", {
                sessionId: sid,
                actorId,
                eventId: decoded.envelope.eventId,
                oldStatus: sc.oldStatus,
                newStatus: sc.newStatus,
              });
              if (isAgentActiveStatus(sc.newStatus)) {
                const flushed = flushTurnAgentReply(
                  sid,
                  actorId,
                  "mqtt.statusChange.active",
                );
                logInterruptMsgDiag("mqtt.statusChange.active", {
                  sessionId: sid,
                  actorId,
                  oldStatus: sc.oldStatus,
                  newStatus: sc.newStatus,
                  flushedPreviousTurn: flushed,
                  ...summarizePendingReplies(
                    pendingStreamRepliesRef.current[agentStreamKey(sid, actorId)],
                  ),
                });
                clearTerminalFlushPending(agentStreamKey(sid, actorId));
                useV2StreamingStore.getState().beginPlanningPlaceholder(sid, actorId);
              } else if (isTerminalAgentStatus(sc.newStatus)) {
                terminalFlushPendingRef.current[agentStreamKey(sid, actorId)] = true;
                const flushed = flushTurnAgentReply(
                  sid,
                  actorId,
                  "mqtt.statusChange.terminal",
                );
                logInterruptMsgDiag("mqtt.statusChange.terminal", {
                  sessionId: sid,
                  actorId,
                  oldStatus: sc.oldStatus,
                  newStatus: sc.newStatus,
                  flushed,
                  ...summarizePendingReplies(
                    pendingStreamRepliesRef.current[agentStreamKey(sid, actorId)],
                  ),
                  ...summarizeStreamEntry(
                    useV2StreamingStore.getState().byKey[agentStreamKey(sid, actorId)],
                    "live",
                  ),
                });
                if (!flushed) {
                  const streamEntry = useV2StreamingStore.getState().byKey[
                    agentStreamKey(sid, actorId)
                  ];
                  if (streamEntryHasVisibleContent(streamEntry)) {
                    const interruptedPending = useV2StreamingStore
                      .getState()
                      .isInterruptedFlushPending(sid, actorId);
                    logInterruptMsgDiag("mqtt.statusChange.terminal.finishOnly", {
                      sessionId: sid,
                      actorId,
                      interruptedPending,
                      ...summarizeStreamEntry(streamEntry, "live"),
                    });
                    if (interruptedPending) {
                      const eagerFlushed = flushInterruptedStreamArtifacts(
                        sid,
                        actorId,
                        "mqtt.statusChange.terminal.finishOnly",
                      );
                      if (eagerFlushed) {
                        useV2StreamingStore
                          .getState()
                          .clearInterruptedFlushPending(sid, actorId);
                      } else {
                        useV2StreamingStore.getState().finishSessionActor(sid, actorId, {
                          reason: "statusChange.terminal",
                        });
                      }
                    } else {
                      useV2StreamingStore.getState().finishSessionActor(sid, actorId, {
                        reason: "statusChange.terminal",
                      });
                    }
                  } else {
                    useV2StreamingStore.getState().setError(
                      sid,
                      actorId,
                      t(
                        "daemon.agentRuntime.emptyReply",
                        "Agent returned no output. The selected model may be unavailable or misconfigured.",
                      ),
                      "",
                    );
                  }
                }
              }
            } else if (event?.case === "error") {
              const er = event.value as { message?: string; details?: string };
              terminalFlushPendingRef.current[agentStreamKey(sid, actorId)] = true;
              flushTurnAgentReply(sid, actorId, "mqtt.error");
              useV2StreamingStore.getState().setError(
                sid,
                actorId,
                er.message ?? "Agent error",
                er.details ?? "",
              );
            } else if (event?.case === "permissionRequest") {
              const pr = event.value as {
                requestId?: string;
                toolName?: string;
                description?: string;
                params?: Record<string, string>;
                options?: Array<{ optionId?: string; kind?: string; name?: string }>;
              };
              logStreamToolDiag("mqtt.permissionRequest", {
                sessionId: sid,
                actorId,
                eventId: decoded.envelope.eventId,
                requestId: pr.requestId,
                toolName: pr.toolName,
                description: pr.description,
                isDoomLoop: pr.toolName === "doom_loop",
              });
              void handleAcpPermissionRequest({
                sessionId: sid,
                agentActorId: actorId,
                request: {
                  requestId: pr.requestId ?? "",
                  toolName: pr.toolName ?? "",
                  description: pr.description ?? "",
                  params: pr.params ?? {},
                  options: (pr.options ?? []).map((o) => ({
                    optionId: o.optionId ?? "",
                    kind: o.kind ?? "",
                    name: o.name ?? "",
                  })),
                },
              });
            } else if (event?.case === "planUpdate") {
              const pu = event.value as { entries?: Array<{ content?: string; priority?: string; status?: string }> };
              useV2StreamingStore.getState().setPlan(
                sid,
                actorId,
                mapAcpPlanEntries(pu.entries ?? []),
              );
            }
            // statusChange / availableCommands / raw: MVP no-op (RuntimeInfo retain
            // already surfaces agent status; commands TBD; raw is catch-all).
          }
        });
        if (cancelled) {
          unlisten?.();
          return;
        }

        // Prefer the member ACL's team-wide session/live subscription so
        // desktop receives replies for sessions that another logged-in client
        // created or moved. Fall back to the old recent-session slice if a
        // broker still has older ACL claims.
        const recentAtBoot = useSessionListStore.getState().rows.slice(0, RECENT_SESSION_SUBSCRIBE_CAP);
        try {
          await ensureTeamSessionLiveSubscribed(mqttTeamId);
          console.log('[MQTT] receiver wired: subscribed to team session/live wildcard');
        } catch (e) {
          console.warn('[MQTT] team session/live wildcard subscribe failed; falling back to recent sessions', e);
          await Promise.all(
            recentAtBoot.map((r) =>
              ensureSessionLiveSubscribed(r.team_id, r.id).catch((err) => {
                console.warn('[MQTT] subscribe failed', `amux/${r.team_id}/session/${r.id}/live`, err);
              }),
            ),
          );
          console.log('[MQTT] receiver wired: subscribed to', recentAtBoot.length, 'recent session/live topics');
        }

        // RPC client: subscribe to the team's rpc/res topic and start correlating.
        await initTeamclawRpc(mqttTeamId);
        console.log('[teamclaw-rpc] initialized for team', mqttTeamId);

        // Runtime state store: subscribe to daemon-published RuntimeInfo retains.
        await initRuntimeStateStore(mqttTeamId);
        console.log('[runtime-state] initialized for team', mqttTeamId);

        // Actor presence: subscribe to daemon LWT-backed online/offline state.
        await initActorPresenceStore(mqttTeamId);
        console.log('[device-presence] initialized for team', mqttTeamId);

        // Background: sync actor directory into local cache so display-name
        // lookups hit libsql instead of Supabase on subsequent renders.
        void syncActorsForTeam(mqttTeamId).catch((e) =>
          console.warn('[cache-sync] actor sync failed:', e),
        );

        // Background: sync ideas into local cache.
        void syncIdeasForTeam(mqttTeamId).catch((e) =>
          console.warn('[cache-sync] idea sync failed:', e),
        );

        // Background: sync sessions into local cache. E2E control owns the
        // session-list rows while active, so skip normal hydration/reloads.
        if (!isV2E2EControlActive()) {
          void syncSessionsForTeam(mqttTeamId).then(() => {
            if (isV2E2EControlActive()) return;
            // Reload session list from merged local cache after sync finishes.
            void useSessionListStore.getState().load();
          }).catch((e) =>
            console.warn('[cache-sync] session sync failed:', e),
          );
        }
      } catch (err) {
        console.error("[MQTT] receiver wiring failed:", err);
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
      pendingStreamRepliesRef.current = {};
      terminalFlushPendingRef.current = {};
      interruptedStreamFlushRef.current = {};
      disposeTeamclawRpc();
      disposeRuntimeStateStore();
      disposeActorPresenceStore();
    };
  }, [mqttAuthKey, userId, mqttTeamId, mqttAccessToken, mqttReconnectNonce]);

  // Keep session/live subscriptions in sync with the user's most-recent
  // sessions. Rows are sorted by last_message_at DESC, so we slice the top
  // RECENT_SESSION_SUBSCRIBE_CAP and subscribe any not-yet-subscribed.
  // When a new session is created and pushed into rows (newest first),
  // it's auto-included here. Older sessions stay un-subscribed until the
  // user activates one (see the activeSessionId effect below).
  const sessionRowsForSubscribe = useSessionListStore((s) => s.rows);
  useEffect(() => {
    if (!userId || !mqttTeamId) return;
    if (hasTeamSessionLiveSubscription(mqttTeamId)) return;
    let cancelled = false;
    const recent = sessionRowsForSubscribe.slice(0, RECENT_SESSION_SUBSCRIBE_CAP);
    void (async () => {
      for (const r of recent) {
        if (cancelled) return;
        await ensureSessionLiveSubscribed(r.team_id, r.id).catch((e) => {
          console.warn('[MQTT] subscribe failed', `amux/${r.team_id}/session/${r.id}/live`, e);
        });
      }
    })();
    return () => { cancelled = true; };
  }, [sessionRowsForSubscribe, userId, mqttTeamId]);

  // Lazy-subscribe on session activation. When the user opens a session
  // that's outside the most-recent slice, subscribe to its live topic so
  // any incoming streaming arrives. Idempotent via the shared dedup set.
  // Reactive on the row's team_id (selector) so this also fires once the
  // session list finishes loading — otherwise a freshly-activated session
  // can race against rows hydration and stay un-subscribed.
  const activeSessionIdForSubscribe = useSessionSelectionStore((s) => s.activeSessionId);
  const activeSessionTeamId = useSessionListStore((s) =>
    activeSessionIdForSubscribe
      ? s.rows.find((r) => r.id === activeSessionIdForSubscribe)?.team_id ?? null
      : null,
  );
  useEffect(() => {
    if (!activeSessionIdForSubscribe || !userId || !mqttTeamId) return;
    if (!activeSessionTeamId) return;
    void ensureSessionLiveSubscribed(
      activeSessionTeamId,
      activeSessionIdForSubscribe,
    );
  }, [activeSessionIdForSubscribe, activeSessionTeamId, userId, mqttTeamId]);

  // v2 Phase 1 → local-first: load message history whenever the active
  // session changes.
  //   1. Tauri: hydrate immediately from local libsql cache (no Supabase wait).
  //   2. Background: delta-sync from Supabase (watermark-based), upsert local,
  //      re-render if anything new arrived.
  //   3. Non-Tauri: full Supabase pull (unchanged behaviour).
  // agent_runtime_event table is no longer read here — those rows were written
  // with origin="mqtt-live" into the message table by new envelope handler code.
  // TODO(cleanup): remove agent_runtime_event table once all clients have
  // upgraded past this version.
  const currentSessionId = useSessionSelectionStore((s) => s.currentSessionId);
  const hasCurrentSession = Boolean(currentSessionId);
  const messageRefreshTrigger = useSessionMessageStore((s) => s.messageRefreshTrigger);
  const messageRefreshForceFull = useSessionMessageStore((s) => s.messageRefreshForceFull);
  const prevRefreshTriggerRef = useRef(0);
  useEffect(() => {
    if (!currentSessionId) return;
    if (isV2E2EControlActive()) return;
    // A refresh-trigger bump on the SAME session = user pressed ↻, or an
    // explicit full reload (e.g. opening a cron session from run history).
    const triggerBumped =
      messageRefreshTrigger !== prevRefreshTriggerRef.current;
    const forceFull =
      messageRefreshForceFull ||
      (triggerBumped && prevRefreshTriggerRef.current !== 0);
    prevRefreshTriggerRef.current = messageRefreshTrigger;
    if (messageRefreshForceFull) {
      useSessionMessageStore.setState({ messageRefreshForceFull: false });
    }
    let cancelled = false;
    const kindMap: Record<string, MessageKind> = {
      text: MessageKind.TEXT,
      system: MessageKind.SYSTEM,
      agent_thinking: MessageKind.AGENT_THINKING,
      agent_tool_call: MessageKind.AGENT_TOOL_CALL,
      agent_tool_result: MessageKind.AGENT_TOOL_RESULT,
      agent_reply: MessageKind.AGENT_REPLY,
    };

    function cacheRowToProto(r: {
      id: string;
      sessionId: string;
      senderActorId?: string | null;
      kind: string;
      content: string;
      model?: string | null;
      createdAt: string;
      turnId?: string | null;
      metadataJson?: string | null;
      partsJson?: string | null;
    }) {
      const proto = createMessage(MessageSchema, {
        messageId: r.id,
        sessionId: r.sessionId,
        senderActorId: r.senderActorId ?? "",
        kind: kindMap[r.kind] ?? MessageKind.TEXT,
        content: r.content ?? "",
        model: r.model ?? "",
        turnId: r.turnId ?? "",
        metadataJson: r.metadataJson ?? "",
        createdAt: BigInt(Math.floor(new Date(r.createdAt).getTime() / 1000)),
      });
      if (r.partsJson) {
        Object.assign(proto, { partsJson: r.partsJson });
      }
      return proto;
    }

    void (async () => {
      if (isTauri()) {
        // ── Phase 1: instant render from local cache ──────────────────
        const { loadMessagesForSession } = await import("@/lib/local-cache");
        const localMsgs = await loadMessagesForSession(
          currentSessionId,
          false,
          workspacePath,
        );
        if (cancelled) return;
        if (localMsgs.length > 0) {
          useSessionMessageStore.getState().setMessages(
            currentSessionId,
            localMsgs.map(cacheRowToProto),
          );
        }

        // ── Phase 2: background delta sync from Supabase ─────────────
        const teamId =
          useSessionListStore.getState().rows.find(
            (r) => r.id === currentSessionId,
          )?.team_id ?? "";
        const synced = await syncMessagesForSession(
          currentSessionId,
          teamId,
          { full: forceFull },
        );
        if (forceFull && teamId) {
          // Also force-refresh participants on user-driven refresh.
          const { syncParticipantsForSession } = await import(
            "@/lib/sync/session-participant-sync"
          );
          await syncParticipantsForSession(currentSessionId, teamId, {
            full: true,
          });
        }
        if (cancelled) return;
        if (synced > 0) {
          // Re-read from local cache to surface the newly-synced rows
          const fresh = await loadMessagesForSession(
            currentSessionId,
            false,
            workspacePath,
          );
          if (!cancelled) {
            useSessionMessageStore.getState().setMessages(
              currentSessionId,
              fresh.map(cacheRowToProto),
            );
          }
        }
        return;
      }

      // ── Non-Tauri: full backend pull ──────────────────────────────
      let historyRows;
      try {
        historyRows = await getBackend().messages.listMessages(currentSessionId);
      } catch (error) {
        console.warn("[history] load failed:", error instanceof Error ? error.message : error);
        return;
      }
      if (cancelled) return;
      const backendMsgs = historyRows.map((r) =>
        createMessage(MessageSchema, {
          messageId: r.id,
          sessionId: r.session_id,
          senderActorId: r.sender_actor_id ?? "",
          kind: kindMap[r.kind] ?? MessageKind.TEXT,
          content: r.content ?? "",
          model: r.model ?? "",
          createdAt: BigInt(Math.floor(new Date(r.created_at).getTime() / 1000)),
        }),
      );
      useSessionMessageStore.getState().setMessages(currentSessionId, backendMsgs);
    })();
    return () => {
      cancelled = true;
    };
  }, [currentSessionId, messageRefreshTrigger, messageRefreshForceFull, workspacePath]);

  /** When left dock opens, hide the main sidebar; restore prior expansion when it closes. */
  const restoreSidebarAfterLeftDockRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (leftDockActive) {
      if (restoreSidebarAfterLeftDockRef.current === null) {
        restoreSidebarAfterLeftDockRef.current = sidebarOpen;
        if (sidebarOpen) {
          setSidebarOpen(false);
        }
      } else if (sidebarOpen) {
        // User re-opened sidebar while left dock is active — close the dock.
        closePanel();
      }
    } else {
      const shouldExpand = restoreSidebarAfterLeftDockRef.current === true;
      restoreSidebarAfterLeftDockRef.current = null;
      if (shouldExpand) {
        setSidebarOpen(true);
      }
    }
  }, [leftDockActive, sidebarOpen, setSidebarOpen, closePanel]);

  const settingsModal = (
    <Dialog
      open={settingsOpen}
      onOpenChange={(open) => {
        if (!open) {
          closeSettings();
        }
      }}
    >
      <DialogContent
        aria-label={t("common.settings", "Settings")}
        className="flex h-[min(780px,calc(100vh-5rem))] w-[min(960px,calc(100vw-4rem))] max-w-none grid-cols-none flex-col gap-0 overflow-hidden rounded-[14px] border-border bg-paper p-0 shadow-2xl sm:max-w-none"
        showCloseButton={false}
      >
        <DialogHeader className="flex h-12 shrink-0 flex-row items-center gap-2 border-b border-border bg-paper px-5 py-0 text-left">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-[15px] font-bold leading-none text-foreground">
              {t("common.settings", "Settings")}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {t("settings.description", "Configure TeamClaw settings.")}
            </DialogDescription>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 rounded-lg px-2 text-[12px] text-muted-foreground hover:bg-selected hover:text-foreground"
            onClick={() => setFeedbackOpen(true)}
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            {t('settings.feedback.title', 'Send Feedback')}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-lg text-muted-foreground hover:bg-selected hover:text-foreground"
            onClick={closeSettings}
            aria-label={t("common.close", "Close")}
          >
            <X className="h-4 w-4" />
          </Button>
        </DialogHeader>
        <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
        <div className="min-h-0 flex-1 overflow-hidden">
          <Settings />
        </div>
      </DialogContent>
    </Dialog>
  );

  if (!initialWorkspaceResolved) {
    return (
      <>
        <AppSidebar />
        <SidebarInset className="flex h-svh flex-col overflow-hidden">
          <header
            className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 bg-background px-4"
            data-tauri-drag-region
          >
            {collapsedInsetLeading}
            <span className="font-medium">{buildConfig.app.name}</span>
          </header>
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </SidebarInset>
        {settingsModal}
      </>
    );
  }

  // If no workspace selected, show workspace prompt
  if (!workspacePath) {
    return (
      <>
        <AppSidebar />
        <SidebarInset className="flex h-svh flex-col overflow-hidden">
          <header
            className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 bg-background px-4"
            data-tauri-drag-region
          >
            {collapsedInsetLeading}
            <span className="font-medium">{buildConfig.app.name}</span>
          </header>
          <div className="flex-1 overflow-hidden">
            <WorkspacePrompt />
          </div>
        </SidebarInset>
        {settingsModal}
      </>
    );
  }

  return (
    <>
      <AppSidebar />
      <div className="w-(--session-list-width) shrink-0 h-svh overflow-hidden">
        <SidebarSecondColumn />
      </div>
      <SidebarInset className="flex flex-row h-svh overflow-hidden relative">
        <div
          className={cn(
            "shrink-0 overflow-hidden border-border bg-background transition-[width,opacity,transform] duration-500 ease-out",
            leftDockActive
              ? "w-(--sidebar-width) translate-x-0 border-r opacity-100"
              : "pointer-events-none w-0 -translate-x-4 border-r-0 opacity-0",
          )}
        >
          <div className="flex h-full w-(--sidebar-width) flex-col overflow-hidden bg-background">
            {leftDockActive && (
              <>
                <div
                  className="flex h-12 shrink-0 items-center gap-1 border-b border-border bg-background px-2"
                  data-tauri-drag-region
                >
                  <TrafficLights />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 rounded-lg"
                    onClick={() => closePanel()}
                    title={t("shortcuts.backToSidebar", "Back to sidebar")}
                    aria-label={t(
                      "shortcuts.backToSidebar",
                      "Back to sidebar",
                    )}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="min-w-0 truncate text-sm font-medium">
                    {t("navigation.shortcuts", "Shortcuts")}
                  </span>
                  <div className="min-w-0 flex-1" data-tauri-drag-region />
                </div>
                <div className="min-h-0 flex-1 overflow-hidden">
                  <RightPanel diff={sessionDiff} />
                </div>
              </>
            )}
          </div>
        </div>
        {/* Main column: header + main content */}
        <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
          {/* Header with breadcrumb - sticky */}
          <header
            className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 bg-background px-4"
            data-tauri-drag-region
          >
            {collapsedInsetLeading}

            <button
              className={cn(
                "min-w-0 truncate text-sm text-left",
                hasActiveFileTab && "cursor-pointer hover:text-foreground/70 transition-colors"
              )}
              onClick={() => {
                if (hasActiveFileTab) {
                  useTabsStore.getState().hideAll();
                }
              }}
              disabled={!hasActiveFileTab}
            >
              {activeSession?.title || t("chat.newChat", "New Chat")}
            </button>
            {activeSession && (
              <button
                onClick={async () => {
                  setIsRefreshingMessages(true);
                  await reloadActiveSessionMessages();
                  setIsRefreshingMessages(false);
                }}
                className="ml-1 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title={t("chat.refreshMessages", "Refresh messages")}
              >
                <RotateCw
                  className={cn(
                    "h-3.5 w-3.5",
                    isRefreshingMessages && "animate-spin",
                  )}
                />
              </button>
            )}

            {/* Panel tabs - right side of header */}
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
              {mainContentLayout === "stacked" && (hasActiveFileTab || hasHiddenTabs) && (
                <button
                  className={cn(
                    "rounded p-1 transition-colors hover:bg-muted hover:text-foreground",
                    hasActiveFileTab ? "text-foreground" : "text-muted-foreground",
                  )}
                  onClick={() => {
                    if (hasActiveFileTab) {
                      useTabsStore.getState().hideAll();
                    } else {
                      useTabsStore.getState().restoreLastTab();
                    }
                  }}
                  title={hasActiveFileTab
                    ? t("navigation.hideTabs", "Hide files")
                    : t("navigation.restoreTabs", "Show files")
                  }
                >
                  <AppWindow className="h-4 w-4" />
                </button>
              )}
              {workspacePath && (
                <TerminalToggleButton workspacePath={workspacePath} />
              )}
              {hasCurrentSession && (
                <HeaderPanelTab
                  icon={Users}
                  label={t("chat.actorSheet.title", "Actors")}
                  isActive={isPanelOpen && activeTab === "actors"}
                  onClick={() => isPanelOpen && activeTab === "actors" ? closePanel() : openPanel("actors")}
                />
              )}
              <HeaderPanelTab
                icon={BookOpen}
                label={t("navigation.knowledge", "Knowledge")}
                isActive={isPanelOpen && activeTab === "knowledge"}
                onClick={() => isPanelOpen && activeTab === "knowledge" ? closePanel() : openPanel("knowledge")}
              />
              {hasCurrentSession && (
                <HeaderPanelTab
                  icon={FolderGit}
                  label={t("navigation.changes", "Changes")}
                  count={sessionDiff.length}
                  isActive={isPanelOpen && activeTab === "diff"}
                  onClick={() => isPanelOpen && activeTab === "diff" ? closePanel() : openPanel("diff")}
                />
              )}
              {showRightWorkspacePanel && (
                <button
                  className="ml-1 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  onClick={closePanel}
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </header>

          <RuntimeRefreshWorkspaceBanner />

          {/* Main content - Chat or file preview */}
          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            <MainContent />
          </div>
        </div>

        {/* Right Panel - full height */}
        <div
          className={cn(
            "shrink-0 overflow-hidden border-l border-border bg-background transition-[width,opacity,transform] duration-500 ease-out",
            showRightWorkspacePanel
              ? "w-72 translate-x-0 opacity-100"
              : "pointer-events-none w-0 translate-x-4 border-l-0 opacity-0",
          )}
        >
          <div className="h-full w-72">
            {showRightWorkspacePanel && (
              <RightPanel diff={sessionDiff} />
            )}
          </div>
        </div>
      </SidebarInset>
      {settingsModal}
    </>
  );
}

function App() {
  React.useEffect(() => {
    installV2E2EControl();
  }, []);

  // ── Global webview shortcuts (find, zoom, context menu) ──
  useWebviewShortcuts()
  useTerminalShortcuts()

  // ── Initialize tauri-plugin-mcp event listeners (dev only) ──
  useEffect(() => {
    if (!isTauri() || import.meta.env.PROD) return;
    // Dynamic import — module only exists in Tauri dev; externalized in prod builds
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    import(/* @vite-ignore */ 'tauri-plugin-mcp').then((mod: { setupPluginListeners?: () => void }) => {
      mod.setupPluginListeners?.();
      console.log('[App] tauri-plugin-mcp listeners initialized');
    }).catch(() => {});
  }, []);

  // ── Deeplink: teamclaw://invite?token=… ───────────────────────────────────
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;

    async function handle(urls: string[]) {
      for (const raw of urls) {
        const token = parseInviteDeeplink(raw);
        if (!token) continue;
        try {
          const claim = await claimInviteToken(token);
          await useCurrentTeamStore.getState().reloadAndSwitchTo(claim.teamId);
          // TODO(Task 12): surface <JoinTeamFlow teamId={claim.teamId}
          //   workspacePath={currentWorkspacePath} /> in an onboarding sheet
          //   here so the joiner auto-pulls workspace config and enters the
          //   team secret. Component lives at
          //   packages/app/src/components/onboarding/JoinTeamFlow.tsx.
        } catch (err) {
          console.error('[invite] claim failed', err);
        }
      }
    }

    // Cold start — link that launched the app
    getCurrent().then((urls) => { if (urls) handle(urls); }).catch(() => {});

    // Hot delivery while app is already open
    onOpenUrl(handle).then((u) => { unlisten = u; }).catch(() => {});

    return () => { unlisten?.(); };
  }, []);

  // Extracted hooks — initialization, setup guide, telemetry consent
  useTauriBodyClass();
  useOpenCodePreload();
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const daemonHttpReady = useWorkspaceStore((s) => s.daemonHttpReady);
  const setupReady = !workspacePath || daemonHttpReady || !isTauri();
  const { showSetupGuide, dependencies, handleRecheck, handleSetupContinue } = useSetupGuide(setupReady);
  const { showConsentDialog, setShowConsentDialog } = useTelemetryConsent(showSetupGuide);

  // First-run welcome — the very first screen, shown before dependency setup.
  // Dismissing it (Get started) is what unblocks the dependency initialization.
  const [welcomeAck, setWelcomeAck] = useState(() => !isTauri() || hasSeenWelcome());
  const showWelcome = isTauri() && !welcomeAck;

  // Welcome / dependency-setup are immediately-interactive first-run screens — if
  // either shows, hand off from the static skeleton right away (AppContent owns
  // the removal on the normal path; this covers the screens that render instead).
  useEffect(() => {
    if (showWelcome || showSetupGuide) removeStartupSkeleton();
  }, [showWelcome, showSetupGuide]);

  const mainContent = showWelcome ? (
    <WelcomeScreen
      onContinue={() => {
        markWelcomeSeen();
        setWelcomeAck(true);
      }}
    />
  ) : (
    <>
      {showSetupGuide && (
        <SetupGuide
          dependencies={dependencies}
          onRecheck={handleRecheck}
          onContinue={handleSetupContinue}
        />
      )}
      {!showSetupGuide && (
        <>
          <SidebarProvider
            style={
              {
                "--sidebar-width": "220px",
                "--session-list-width": "280px",
              } as React.CSSProperties
            }
          >
            <AppContent />
          </SidebarProvider>
          <Toaster
            position="top-center"
            offset={40}
            toastOptions={{
              className: '!bg-popover !text-popover-foreground !border-border !shadow-md !rounded-md !text-xs !py-2 !px-3 !min-h-0 !gap-1.5',
              descriptionClassName: '!text-muted-foreground !text-[11px]',
            }}
          />
          <UpdateDialogContainer />
          <NewSessionDialog />
          <TelemetryConsentDialog
            open={showConsentDialog}
            onComplete={() => setShowConsentDialog(false)}
          />
        </>
      )}
    </>
  )

  return isTauri() ? (
    <div className="h-screen w-screen rounded-2xl overflow-hidden bg-background">
      {mainContent}
    </div>
  ) : (
    <>{mainContent}</>
  )
}

export default App;
