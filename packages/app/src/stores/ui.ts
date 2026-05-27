import { create } from 'zustand'
import { useWorkspaceStore } from '@/stores/workspace'

type View = 'chat' | 'settings'

export type LayoutMode = 'task'
export type MainContentLayout = 'stacked' | 'split'

// Right panel tab in file mode
export type FileModeRightTab = 'shortcuts' | 'changes' | 'files' | 'agent'
export type DefaultPrimaryTab = 'session' | 'actors' | 'ideas' | 'shortcuts'
export type DefaultMoreDestination = 'settings'

/** Preselected actor for the draft chat state: when the user taps an actor
 * row in the Actors tab, we record it here, switch nav back to Session, and
 * clear activeSessionId. ChatPanel's "no active session" branch then renders
 * a draft view that uses this actor's name as the title and creates a solo
 * session directly on send, bypassing the new-session dialog. */
export type DraftActor = { id: string; displayName: string; kind: 'member' | 'agent' }

/** Selector for what the workspace sidebar's column 2 displays. */
export type SidebarFilter =
  | { kind: 'all' }
  | { kind: 'pinned' }
  | { kind: 'shortcuts' }
  | { kind: 'ideas' }
  | { kind: 'actors' }
  | { kind: 'actor'; actorId: string; displayName: string; actorType: 'member' | 'agent' }
  | { kind: 'idea'; ideaId: string; title: string }

export type SettingsSection = 'llm' | 'general' | 'server' | 'voice' | 'prompt' | 'mcp' | 'channels' | 'automation' | 'daemonGeneral' | 'daemonWorkspaces' | 'daemonRuntimes' | 'team' | 'envVars' | 'skills' | 'roles' | 'rolesSkills' | 'knowledge' | 'deps' | 'tokenUsage' | 'privacy' | 'permissions' | 'leaderboard' | 'shortcuts' | 'cache'

interface UIState {
  currentView: View
  layoutMode: LayoutMode
  mainContentLayout: MainContentLayout
  fileModeRightTab: FileModeRightTab
  defaultNavTab: DefaultPrimaryTab
  defaultMoreOpen: boolean
  /** Toggle for the session-scoped Actors sheet (the right-side slideover
   * that lists members + agents for the current session). Lives in ui-store
   * so the header trigger (App.tsx) and the sheet mount (ChatPanel) can
   * share state. */
  actorSheetOpen: boolean
  settingsInitialSection: SettingsSection | null
  draftPreselectedActor: DraftActor | null
  sidebarFilter: SidebarFilter
  ideasSectionCollapsed: boolean
  actorsSectionCollapsed: boolean
  draftIdeaId: string | null
  /** Modal "新会话" dialog (NavRail entry + intercepted send-with-no-session). */
  newSessionDialogOpen: boolean
  /** Message text the dialog opens with — used when the user typed in the
   * empty-session input then hit send (we redirect into the dialog so the
   * draft isn't lost). */
  newSessionDialogInitialMessage: string | null
  openNewSessionDialog: (initialMessage?: string | null) => void
  closeNewSessionDialog: () => void
  setSidebarFilter: (filter: SidebarFilter) => void
  toggleIdeasSection: () => void
  toggleActorsSection: () => void
  setDraftIdeaId: (ideaId: string) => void
  clearDraftIdeaId: () => void
  setView: (view: View) => void
  setDefaultMoreOpen: (open: boolean) => void
  setActorSheetOpen: (open: boolean) => void
  toggleActorSheet: () => void
  selectDefaultPrimaryTab: (tab: DefaultPrimaryTab) => void
  openDefaultMoreDestination: (destination: DefaultMoreDestination) => Promise<void> | void
  openSettings: (section?: SettingsSection) => void
  closeSettings: () => void
  setLayoutMode: (mode: LayoutMode) => void
  toggleLayoutMode: () => void
  toggleMainContentLayout: () => void
  setFileModeRightTab: (tab: FileModeRightTab) => void
  startNewChat: () => void
  switchToSession: (sessionId: string) => Promise<void>
  enterActorDraft: (actor: DraftActor) => void
  clearActorDraft: () => void
}

export const useUIStore = create<UIState>((set, get) => ({
  currentView: 'chat',
  layoutMode: 'task',
  mainContentLayout: 'stacked',
  fileModeRightTab: 'agent',
  defaultNavTab: 'session',
  defaultMoreOpen: false,
  actorSheetOpen: false,
  settingsInitialSection: null,
  draftPreselectedActor: null,
  sidebarFilter: { kind: 'all' },
  ideasSectionCollapsed: false,
  actorsSectionCollapsed: false,
  draftIdeaId: null,
  newSessionDialogOpen: false,
  newSessionDialogInitialMessage: null,

  openNewSessionDialog: (initialMessage) => set({
    newSessionDialogOpen: true,
    newSessionDialogInitialMessage: initialMessage ?? null,
  }),
  closeNewSessionDialog: () => set({
    newSessionDialogOpen: false,
    newSessionDialogInitialMessage: null,
  }),

  setView: (view) => set({ currentView: view }),

  setDefaultMoreOpen: (open) => set({ defaultMoreOpen: open }),

  setActorSheetOpen: (open) => set({ actorSheetOpen: open }),
  toggleActorSheet: () => set((s) => ({ actorSheetOpen: !s.actorSheetOpen })),

  selectDefaultPrimaryTab: (tab) => {
    const ws = useWorkspaceStore.getState()

    set({
      defaultNavTab: tab,
      defaultMoreOpen: false,
      currentView: 'chat',
      settingsInitialSection: null,
    })

    if (tab === 'session') {
      ws.clearSelection()
      ws.closePanel()
      return
    }

    ws.clearSelection()
    ws.closePanel()
  },

  openDefaultMoreDestination: (destination) => {
    set({ defaultMoreOpen: false })

    if (destination === 'settings') {
      get().openSettings()
      return
    }
  },

  openSettings: (section) => set({
    currentView: 'settings',
    settingsInitialSection: section ?? null,
  }),

  closeSettings: () => set({ currentView: 'chat', settingsInitialSection: null }),

  startNewChat: () => {
    // Switch to chat view synchronously so settings hides immediately —
    // waiting on the dynamic imports below would leave the settings UI
    // visible until the import chain resolves.
    set({
      currentView: 'chat',
      settingsInitialSection: null,
      // Starting a fresh chat overrides any pending actor-draft selection.
      draftPreselectedActor: null,
      sidebarFilter: { kind: 'all' },
      draftIdeaId: null,
    })
    const isStacked = get().mainContentLayout === 'stacked'

    // Import session and other stores lazily to avoid circular dependencies
    import('@/stores/session-selection-store').then(({ useSessionSelectionStore }) => {
      import('@/stores/workspace').then(({ useWorkspaceStore }) => {
        import('@/stores/tabs').then(({ useTabsStore }) => {
          import('@/stores/streaming').then(({ useStreamingStore }) => {
            import('@/stores/session').then(({ useSessionStore }) => {
            useWorkspaceStore.getState().clearSelection()
            useWorkspaceStore.getState().closePanel()
            // Only deactivate the editor multi-tab pane in stacked layout —
            // in stacked mode chat and tabs share the same slot, so we need
            // to hide tabs to reveal the chat view. In split layout the
            // chat pane is already visible alongside the tabs, so closing
            // them just makes the user's open files vanish for no reason.
            if (isStacked) {
              useTabsStore.getState().hideAll()
            }
            useStreamingStore.getState().clearStreaming()
            useSessionSelectionStore.getState().clearActiveSession()

            // Clear session state to show "Start a New Chat" UI
            // Actual session will be created when user sends first message
            useSessionStore.setState({
              isLoading: false,
              messageQueue: [],
              todos: [],
              sessionDiff: [],
              sessionError: null,
              sessionStatus: null,
              pendingQuestions: [],
              pendingPermissions: [],
            })
            })
          })
        })
      })
    })
  },

  switchToSession: async (sessionId: string) => {
    // Import stores lazily to avoid circular dependencies
    const { useSessionSelectionStore } = await import('@/stores/session-selection-store')
    const { useWorkspaceStore } = await import('@/stores/workspace')
    const { useTabsStore } = await import('@/stores/tabs')
    
    // Skip if already on this session (avoid unnecessary reloads)
    const currentActiveId = useSessionSelectionStore.getState().activeSessionId
    if (sessionId === currentActiveId) {
      return
    }
    
    // Close any open UI elements and return to chat view
    set({
      currentView: 'chat',
      settingsInitialSection: null,
    })
    useWorkspaceStore.getState().clearSelection()
    useTabsStore.getState().hideAll()
    
    // Switch to the session (selection store also updates the read marker).
    await useSessionSelectionStore.getState().setActiveSession(sessionId)
    // If the user was in actor-draft mode, drop that since they jumped into
    // an existing session.
    set({ draftPreselectedActor: null, sidebarFilter: { kind: 'all' }, draftIdeaId: null })
  },

  enterActorDraft: (actor) => {
    set({
      draftPreselectedActor: actor,
      draftIdeaId: null,
      defaultNavTab: 'session',
      defaultMoreOpen: false,
      currentView: 'chat',
      settingsInitialSection: null,
    })
    // Mirror startNewChat's clear-out so the chat view shows an empty
    // canvas with the preselected actor as the implicit recipient. We
    // dynamic-import to avoid a top-level cycle with session/workspace stores.
    void (async () => {
      const { useSessionSelectionStore } = await import('@/stores/session-selection-store')
      const { useSessionStore } = await import('@/stores/session')
      const { useWorkspaceStore } = await import('@/stores/workspace')
      useWorkspaceStore.getState().clearSelection()
      useWorkspaceStore.getState().closePanel()
      useSessionSelectionStore.getState().clearActiveSession()
      useSessionStore.setState({
        isLoading: false,
        messageQueue: [],
        todos: [],
        sessionDiff: [],
        sessionError: null,
        sessionStatus: null,
        pendingQuestions: [],
        pendingPermissions: [],
      })
    })()
  },

  clearActorDraft: () => set({ draftPreselectedActor: null }),

  setSidebarFilter: (filter) => set({ sidebarFilter: filter }),
  toggleIdeasSection: () => set((s) => ({ ideasSectionCollapsed: !s.ideasSectionCollapsed })),
  toggleActorsSection: () => set((s) => ({ actorsSectionCollapsed: !s.actorsSectionCollapsed })),
  setDraftIdeaId: (ideaId) => set({ draftIdeaId: ideaId }),
  clearDraftIdeaId: () => set({ draftIdeaId: null }),

  setLayoutMode: () => set({ layoutMode: 'task' }),

  toggleLayoutMode: () => set({ layoutMode: 'task' }),

  toggleMainContentLayout: () => set((state) => ({
    mainContentLayout: state.mainContentLayout === 'stacked' ? 'split' : 'stacked'
  })),

  setFileModeRightTab: (tab) => set({ fileModeRightTab: tab }),
}))
