import { create } from "zustand";
import type { ToolCall } from "@/stores/session-types";

export interface StreamingPlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export interface StreamingPermissionRequest {
  requestId: string;
  toolName: string;
  description: string;
  params: Record<string, string>;
}

export interface AgentStreamEntry {
  sessionId: string;
  actorId: string;
  outputText: string;           // accumulated output deltas, or final content after finalize
  thinkingText: string;         // accumulated thinking deltas
  toolCalls: ToolCall[];        // pushed on AcpToolUse, completed on AcpToolResult
  planEntries: StreamingPlanEntry[]; // replaced wholesale on AcpPlanUpdate
  pendingPermission: StreamingPermissionRequest | null; // set on AcpPermissionRequest
  errorMessage: string | null;  // set on AcpError
  errorDetails: string | null;
  lastUpdate: number;           // ms epoch
  active: boolean;              // true while streaming; false after finalize
}

export interface ArchivedEntry extends AgentStreamEntry {
  /** Stable React key for the archived bubble — `${sessionId}::${actorId}::${counter}`. */
  archiveId: string;
}

interface State {
  byKey: Record<string, AgentStreamEntry>;
  /** Prior-turn entries archived when the next turn starts. We keep these so
   * thinking + tool_calls from earlier turns stay visible in the UI — the
   * daemon doesn't persist non-AgentReply kinds, so the bubble is the only
   * place they survive. Each entry has a unique `archiveId` for React keys. */
  archived: ArchivedEntry[];
  appendOutput: (sessionId: string, actorId: string, delta: string) => void;
  appendThinking: (sessionId: string, actorId: string, delta: string) => void;
  pushToolUse: (
    sessionId: string,
    actorId: string,
    args: { toolId: string; toolName: string; description: string; params: Record<string, string>; toolKind?: string },
  ) => void;
  completeToolUse: (
    sessionId: string,
    actorId: string,
    args: { toolId: string; success: boolean; summary: string },
  ) => void;
  setPlan: (sessionId: string, actorId: string, entries: StreamingPlanEntry[]) => void;
  setError: (sessionId: string, actorId: string, message: string, details: string) => void;
  setPermissionRequest: (
    sessionId: string,
    actorId: string,
    req: StreamingPermissionRequest,
  ) => void;
  clearPermissionRequest: (sessionId: string, actorId: string) => void;
  finalize: (sessionId: string, actorId: string, finalText: string) => void;
  clearActor: (sessionId: string, actorId: string) => void;
  clearSession: (sessionId: string) => void;
}

function k(sessionId: string, actorId: string): string {
  return `${sessionId}::${actorId}`;
}

function emptyEntry(sessionId: string, actorId: string): AgentStreamEntry {
  return {
    sessionId,
    actorId,
    outputText: "",
    thinkingText: "",
    toolCalls: [],
    planEntries: [],
    pendingPermission: null,
    errorMessage: null,
    errorDetails: null,
    lastUpdate: Date.now(),
    active: true,
  };
}

let archiveCounter = 0;

/** Returned by mutation prep: the entry to mutate AND any prior-turn entry
 * that should be archived in the same set() call. */
interface MutationPrep {
  entry: AgentStreamEntry;
  toArchive: ArchivedEntry | null;
}

/** Get the entry to mutate. If a previous-turn entry exists but is inactive
 * (finalized), capture it for archival and start a fresh entry for the new
 * turn — keeps prior turns' thinking + tool_calls visible in the UI. */
function prepareMutation(state: State, sessionId: string, actorId: string): MutationPrep {
  const key = k(sessionId, actorId);
  const existing = state.byKey[key];
  if (!existing) return { entry: emptyEntry(sessionId, actorId), toArchive: null };
  if (existing.active) return { entry: existing, toArchive: null };
  archiveCounter += 1;
  const archived: ArchivedEntry = {
    ...existing,
    archiveId: `${sessionId}::${actorId}::${archiveCounter}`,
  };
  return { entry: emptyEntry(sessionId, actorId), toArchive: archived };
}

export const useV2StreamingStore = create<State>((set, get) => ({
  byKey: {},
  archived: [],

  appendOutput: (sessionId, actorId, delta) => {
    if (!delta) return;
    const state = get();
    const { entry, toArchive } = prepareMutation(state, sessionId, actorId);
    set({
      byKey: {
        ...state.byKey,
        [k(sessionId, actorId)]: {
          ...entry,
          outputText: entry.outputText + delta,
          lastUpdate: Date.now(),
          active: true,
        },
      },
      archived: toArchive ? [...state.archived, toArchive] : state.archived,
    });
  },

  appendThinking: (sessionId, actorId, delta) => {
    if (!delta) return;
    const state = get();
    const { entry, toArchive } = prepareMutation(state, sessionId, actorId);
    set({
      byKey: {
        ...state.byKey,
        [k(sessionId, actorId)]: {
          ...entry,
          thinkingText: entry.thinkingText + delta,
          lastUpdate: Date.now(),
          active: true,
        },
      },
      archived: toArchive ? [...state.archived, toArchive] : state.archived,
    });
  },

  pushToolUse: (sessionId, actorId, { toolId, toolName, description, params, toolKind }) => {
    if (!toolId) return;
    const state = get();
    const { entry, toArchive } = prepareMutation(state, sessionId, actorId);
    if (entry.toolCalls.some((tc) => tc.id === toolId)) return;
    const newToolCall: ToolCall = {
      id: toolId,
      name: toolName || "unknown",
      toolKind: toolKind || undefined,
      status: "calling",
      arguments: { ...(params ?? {}), ...(description ? { _description: description } : {}) },
      startTime: new Date(),
    };
    set({
      byKey: {
        ...state.byKey,
        [k(sessionId, actorId)]: {
          ...entry,
          toolCalls: [...entry.toolCalls, newToolCall],
          lastUpdate: Date.now(),
          active: true,
        },
      },
      archived: toArchive ? [...state.archived, toArchive] : state.archived,
    });
  },

  completeToolUse: (sessionId, actorId, { toolId, success, summary }) => {
    if (!toolId) return;
    const key = k(sessionId, actorId);
    const existing = get().byKey[key];
    if (!existing) return;
    const updated = existing.toolCalls.map((tc) =>
      tc.id === toolId
        ? {
            ...tc,
            status: success ? ("completed" as const) : ("failed" as const),
            result: summary,
            duration: Date.now() - tc.startTime.getTime(),
          }
        : tc,
    );
    set({
      byKey: {
        ...get().byKey,
        [key]: {
          ...existing,
          toolCalls: updated,
          lastUpdate: Date.now(),
        },
      },
    });
  },

  setPlan: (sessionId, actorId, entries) => {
    const state = get();
    const { entry, toArchive } = prepareMutation(state, sessionId, actorId);
    set({
      byKey: {
        ...state.byKey,
        [k(sessionId, actorId)]: {
          ...entry,
          planEntries: entries,
          lastUpdate: Date.now(),
          active: true,
        },
      },
      archived: toArchive ? [...state.archived, toArchive] : state.archived,
    });
  },

  setError: (sessionId, actorId, message, details) => {
    const state = get();
    const { entry, toArchive } = prepareMutation(state, sessionId, actorId);
    set({
      byKey: {
        ...state.byKey,
        [k(sessionId, actorId)]: {
          ...entry,
          errorMessage: message,
          errorDetails: details,
          lastUpdate: Date.now(),
          active: true,
        },
      },
      archived: toArchive ? [...state.archived, toArchive] : state.archived,
    });
  },

  setPermissionRequest: (sessionId, actorId, req) => {
    const state = get();
    const { entry, toArchive } = prepareMutation(state, sessionId, actorId);
    set({
      byKey: {
        ...state.byKey,
        [k(sessionId, actorId)]: {
          ...entry,
          pendingPermission: req,
          lastUpdate: Date.now(),
          active: true,
        },
      },
      archived: toArchive ? [...state.archived, toArchive] : state.archived,
    });
  },

  clearPermissionRequest: (sessionId, actorId) => {
    const key = k(sessionId, actorId);
    const existing = get().byKey[key];
    if (!existing) return;
    set({
      byKey: {
        ...get().byKey,
        [key]: { ...existing, pendingPermission: null, lastUpdate: Date.now() },
      },
    });
  },

  /** Finalize a streaming turn: replace outputText with the canonical final
   * content from the daemon's published Message and mark inactive. Keep
   * thinking + tool_calls + plan visible — the next turn's first acp.event
   * will move this entry into `archived` (see prepareMutation) so prior-turn
   * thinking + tool_calls stay visible alongside the new turn. */
  finalize: (sessionId, actorId, finalText) => {
    const key = k(sessionId, actorId);
    const existing = get().byKey[key];
    if (!existing) {
      // No prior streaming for this actor — create a finalized stub so the
      // bubble still renders the reply text consistently. (Rare; usually
      // the daemon emits acp.event before message.created.)
      set({
        byKey: {
          ...get().byKey,
          [key]: {
            ...emptyEntry(sessionId, actorId),
            outputText: finalText,
            active: false,
          },
        },
      });
      return;
    }
    set({
      byKey: {
        ...get().byKey,
        [key]: {
          ...existing,
          outputText: finalText || existing.outputText,
          lastUpdate: Date.now(),
          active: false,
        },
      },
    });
  },

  clearActor: (sessionId, actorId) => {
    const key = k(sessionId, actorId);
    const next = { ...get().byKey };
    delete next[key];
    set({
      byKey: next,
      archived: get().archived.filter(
        (e) => !(e.sessionId === sessionId && e.actorId === actorId),
      ),
    });
  },

  clearSession: (sessionId) => {
    const next: Record<string, AgentStreamEntry> = {};
    for (const [key, entry] of Object.entries(get().byKey)) {
      if (entry.sessionId !== sessionId) next[key] = entry;
    }
    set({
      byKey: next,
      archived: get().archived.filter((e) => e.sessionId !== sessionId),
    });
  },
}));

/** Selector helper: get all streaming entries for a session (active + finalized
 * current turn) plus any archived prior turns. Ordered by lastUpdate so the
 * UI can render bubbles in chronological order. */
export function selectStreamsForSession(state: State, sessionId: string): AgentStreamEntry[] {
  const current = Object.values(state.byKey).filter((e) => e.sessionId === sessionId);
  const archived = state.archived.filter((e) => e.sessionId === sessionId);
  return [...archived, ...current].sort((a, b) => a.lastUpdate - b.lastUpdate);
}
