import { create } from "zustand";
import type { MessagePart, ToolCall } from "@/stores/session-types";

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
  parts: MessagePart[];         // ordered live render parts: text/tool-call as ACP events arrive
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
  replaceParts: (sessionId: string, actorId: string, parts: MessagePart[]) => void;
  ingestReplyPreview: (sessionId: string, actorId: string, text: string) => void;
  finalize: (sessionId: string, actorId: string, finalText: string) => void;
  finishSessionActor: (sessionId: string, actorId: string) => void;
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
    parts: [],
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

function entryParts(entry: AgentStreamEntry): MessagePart[] {
  return Array.isArray(entry.parts) ? entry.parts : [];
}

function appendOverlappingChunk(existing: string, chunk: string): string {
  if (!existing || !chunk) return existing + chunk;
  const maxOverlap = Math.min(existing.length, chunk.length);
  for (let length = maxOverlap; length > 0; length -= 1) {
    if (existing.endsWith(chunk.slice(0, length))) {
      return existing + chunk.slice(length);
    }
  }
  return existing + chunk;
}

function appendTextPart(parts: MessagePart[], delta: string): MessagePart[] {
  const last = parts[parts.length - 1];
  if (last?.type === "text") {
    const text = `${last.text || last.content || ""}${delta}`;
    return [
      ...parts.slice(0, -1),
      {
        ...last,
        text,
        content: text,
      },
    ];
  }
  return [
    ...parts,
    {
      id: `stream:text:${Date.now()}:${parts.length}`,
      type: "text",
      text: delta,
      content: delta,
    },
  ];
}

function appendReasoningPart(parts: MessagePart[], delta: string): MessagePart[] {
  const last = parts[parts.length - 1];
  if (last?.type === "reasoning") {
    const text = appendOverlappingChunk(last.text || last.content || "", delta);
    return [
      ...parts.slice(0, -1),
      {
        ...last,
        text,
        content: text,
      },
    ];
  }
  return [
    ...parts,
    {
      id: `stream:reasoning:${Date.now()}:${parts.length}`,
      type: "reasoning",
      text: delta,
      content: delta,
    },
  ];
}

function replacePartText(part: MessagePart, text: string): MessagePart {
  return {
    ...part,
    text,
    content: text,
  };
}

function lastIndexWhere<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

function placePostToolTextPart(parts: MessagePart[], text: string): MessagePart[] {
  const lastToolIndex = lastIndexWhere(parts, (part) => part.type === "tool-call");
  if (lastToolIndex === -1) return appendTextPart(parts, text);

  const existingTextIndex = parts.findIndex(
    (part, index) => index > lastToolIndex && part.type === "text",
  );
  if (existingTextIndex !== -1) {
    const existing = parts[existingTextIndex];
    const existingText = existing.text || existing.content || "";
    if (existingText === text || existingText.includes(text)) return parts;
    return parts.map((part, index) =>
      index === existingTextIndex ? replacePartText(part, text) : part,
    );
  }

  const toolPart = parts[lastToolIndex];
  const previewId = `stream:text:reply-preview:${toolPart.toolCallId || toolPart.id}`;
  return [
    ...parts,
    {
      id: previewId,
      type: "text",
      text,
      content: text,
    },
  ];
}

function withCompletedTool(
  toolCalls: ToolCall[],
  toolId: string,
  success: boolean,
  summary: string,
): ToolCall[] {
  return toolCalls.map((tc) =>
    tc.id === toolId
      ? {
          ...tc,
          status: success ? ("completed" as const) : ("failed" as const),
          result: summary,
          duration: Date.now() - tc.startTime.getTime(),
        }
      : tc,
  );
}

function completedToolPlaceholder(
  toolId: string,
  success: boolean,
  summary: string,
): ToolCall {
  return {
    id: toolId,
    name: "unknown",
    status: success ? "completed" : "failed",
    arguments: {},
    result: summary,
    duration: 0,
    startTime: new Date(),
  };
}

function toolCallPart(toolCall: ToolCall): MessagePart {
  return {
    id: `stream:tool:${toolCall.id}`,
    type: "tool-call",
    toolCallId: toolCall.id,
    toolCall,
  };
}

function syncToolParts(parts: MessagePart[], toolCalls: ToolCall[]): MessagePart[] {
  const byId = new Map(toolCalls.map((tc) => [tc.id, tc]));
  return parts.map((part) => {
    if (part.type !== "tool-call" || !part.toolCallId) return part;
    const toolCall = byId.get(part.toolCallId);
    return toolCall ? { ...part, toolCall } : part;
  });
}

function reviveToolCall(toolCall: ToolCall): ToolCall {
  const rawStartTime = toolCall.startTime as unknown;
  return {
    ...toolCall,
    startTime:
      rawStartTime instanceof Date
        ? rawStartTime
        : typeof rawStartTime === "string" || typeof rawStartTime === "number"
          ? new Date(rawStartTime)
          : new Date(),
  };
}

function reviveToolCallPart(part: MessagePart): MessagePart {
  if (part.type !== "tool-call" || !part.toolCall) return part;
  return {
    ...part,
    toolCall: reviveToolCall(part.toolCall),
  };
}

function finishUnresolvedTools(toolCalls: ToolCall[]): ToolCall[] {
  return toolCalls.map((tc) => {
    if (tc.status !== "calling" && tc.status !== "waiting") return tc;
    return {
      ...tc,
      status: "failed" as const,
      result: "Stream ended before this tool returned a result.",
      duration: Date.now() - tc.startTime.getTime(),
    };
  });
}

function toolUseArguments(
  params: Record<string, string>,
  description: string,
): Record<string, unknown> {
  return {
    ...(params ?? {}),
    ...(description ? { _description: description } : {}),
  };
}

function mergeToolUse(
  existing: ToolCall,
  args: {
    toolName: string;
    description: string;
    params: Record<string, string>;
    toolKind?: string;
  },
): ToolCall {
  const nextArgs = toolUseArguments(args.params, args.description);
  const name =
    args.toolName && args.toolName !== "unknown" ? args.toolName : existing.name;
  return {
    ...existing,
    name,
    toolKind: args.toolKind || existing.toolKind,
    arguments: {
      ...(existing.arguments ?? {}),
      ...nextArgs,
    },
  };
}

function previewTextUpdate(
  entry: AgentStreamEntry,
  text: string,
): { outputText: string; parts: MessagePart[] } {
  const current = entry.outputText || "";
  const parts = entryParts(entry);

  if (!text) {
    return { outputText: current, parts };
  }
  if (text === current || current.includes(text)) {
    return { outputText: current || text, parts };
  }
  if (text.startsWith(current)) {
    const suffix = text.slice(current.length);
    return {
      outputText: text,
      parts: suffix ? appendTextPart(parts, suffix) : parts,
    };
  }
  if (current.length === 0) {
    return {
      outputText: text,
      parts: appendTextPart(parts, text),
    };
  }

  // Last-resort mismatch: keep the visible preview current without trying
  // to diff unrelated partial strings. With tool parts present, ChatMessage
  // renders ordered `parts` instead of `content`, so the preview text must
  // be placed after the latest tool call to remain visible.
  return {
    outputText: text,
    parts: parts.some((part) => part.type === "tool-call")
      ? placePostToolTextPart(parts, text)
      : parts.some((part) => part.type === "text")
        ? parts.map((part, index) =>
            index === lastIndexWhere(parts, (p) => p.type === "text")
              ? replacePartText(part, text)
              : part,
          )
        : appendTextPart(parts, text),
  };
}

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
          parts: appendTextPart(entryParts(entry), delta),
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
          thinkingText: appendOverlappingChunk(entry.thinkingText, delta),
          parts: appendReasoningPart(entryParts(entry), delta),
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
    if (entry.toolCalls.some((tc) => tc.id === toolId)) {
      const toolCalls = entry.toolCalls.map((tc) =>
        tc.id === toolId
          ? mergeToolUse(tc, { toolName, description, params, toolKind })
          : tc,
      );
      set({
        byKey: {
          ...state.byKey,
          [k(sessionId, actorId)]: {
            ...entry,
            toolCalls,
            parts: syncToolParts(entryParts(entry), toolCalls),
            lastUpdate: Date.now(),
            active: true,
          },
        },
        archived: toArchive ? [...state.archived, toArchive] : state.archived,
      });
      return;
    }
    const newToolCall: ToolCall = {
      id: toolId,
      name: toolName || "unknown",
      toolKind: toolKind || undefined,
      status: "calling",
      arguments: toolUseArguments(params, description),
      startTime: new Date(),
    };
    set({
      byKey: {
        ...state.byKey,
        [k(sessionId, actorId)]: {
          ...entry,
          toolCalls: [...entry.toolCalls, newToolCall],
          parts: [
            ...entryParts(entry),
            {
              id: `stream:tool:${toolId}`,
              type: "tool-call",
              toolCallId: toolId,
              toolCall: newToolCall,
            },
          ],
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
    const state = get();
    const existing = state.byKey[key];
    const fallbackToolCall = completedToolPlaceholder(toolId, success, summary);
    if (!existing) {
      set({
        byKey: {
          ...state.byKey,
          [key]: {
            ...emptyEntry(sessionId, actorId),
            toolCalls: [fallbackToolCall],
            parts: [toolCallPart(fallbackToolCall)],
            lastUpdate: Date.now(),
            active: true,
          },
        },
      });
      return;
    }
    const hasToolCall = existing.toolCalls.some((tc) => tc.id === toolId);
    const updated = hasToolCall
      ? withCompletedTool(existing.toolCalls, toolId, success, summary)
      : [...existing.toolCalls, fallbackToolCall];
    const parts = hasToolCall
      ? syncToolParts(entryParts(existing), updated)
      : [...entryParts(existing), toolCallPart(fallbackToolCall)];
    set({
      byKey: {
        ...state.byKey,
        [key]: {
          ...existing,
          toolCalls: updated,
          parts,
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

  replaceParts: (sessionId, actorId, parts) => {
    const key = k(sessionId, actorId);
    const existing = get().byKey[key];
    if (!existing) return;
    const revivedParts = parts.map(reviveToolCallPart);
    const enrichedToolCalls = revivedParts
      .filter((part) => part.type === "tool-call" && part.toolCall)
      .map((part) => part.toolCall!);
    const enrichedById = new Map(enrichedToolCalls.map((tc) => [tc.id, tc]));
    const mergedToolCalls = [
      ...existing.toolCalls.map((tc) => enrichedById.get(tc.id) ?? tc),
      ...enrichedToolCalls.filter(
        (tc) => !existing.toolCalls.some((existingTc) => existingTc.id === tc.id),
      ),
    ];
    set({
      byKey: {
        ...get().byKey,
        [key]: {
          ...existing,
          parts: revivedParts,
          toolCalls: mergedToolCalls,
          lastUpdate: Date.now(),
        },
      },
    });
  },

  ingestReplyPreview: (sessionId, actorId, text) => {
    if (!text) return;
    const state = get();
    const { entry, toArchive } = prepareMutation(state, sessionId, actorId);
    const preview = previewTextUpdate(entry, text);
    set({
      byKey: {
        ...state.byKey,
        [k(sessionId, actorId)]: {
          ...entry,
          outputText: preview.outputText,
          parts: preview.parts,
          lastUpdate: Date.now(),
          active: true,
        },
      },
      archived: toArchive ? [...state.archived, toArchive] : state.archived,
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
            parts: finalText ? appendTextPart([], finalText) : [],
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
          parts: finalText
            ? previewTextUpdate(existing, finalText).parts
            : entryParts(existing),
          lastUpdate: Date.now(),
          active: false,
        },
      },
    });
  },

  finishSessionActor: (sessionId, actorId) => {
    const key = k(sessionId, actorId);
    const existing = get().byKey[key];
    if (!existing) return;
    const toolCalls = finishUnresolvedTools(existing.toolCalls);
    set({
      byKey: {
        ...get().byKey,
        [key]: {
          ...existing,
          toolCalls,
          parts: syncToolParts(entryParts(existing), toolCalls),
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
