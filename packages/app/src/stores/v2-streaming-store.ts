import { create } from "zustand";
import type { ToolCall } from "@/stores/session-types";

export interface AgentStreamEntry {
  sessionId: string;
  actorId: string;
  outputText: string; // accumulated output deltas
  thinkingText: string; // accumulated thinking deltas
  toolCalls: ToolCall[]; // pushed on AcpToolUse, completed on AcpToolResult
  lastUpdate: number; // ms epoch
  active: boolean; // true until final message.created arrives or status change resets it
}

interface State {
  // keyed by `${sessionId}::${actorId}`
  byKey: Record<string, AgentStreamEntry>;
  appendOutput: (sessionId: string, actorId: string, delta: string) => void;
  appendThinking: (sessionId: string, actorId: string, delta: string) => void;
  pushToolUse: (
    sessionId: string,
    actorId: string,
    args: { toolId: string; toolName: string; description: string; params: Record<string, string> },
  ) => void;
  completeToolUse: (
    sessionId: string,
    actorId: string,
    args: { toolId: string; success: boolean; summary: string },
  ) => void;
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
    lastUpdate: Date.now(),
    active: true,
  };
}

export const useV2StreamingStore = create<State>((set, get) => ({
  byKey: {},

  appendOutput: (sessionId, actorId, delta) => {
    if (!delta) return;
    const key = k(sessionId, actorId);
    const existing = get().byKey[key] ?? emptyEntry(sessionId, actorId);
    set({
      byKey: {
        ...get().byKey,
        [key]: {
          ...existing,
          outputText: existing.outputText + delta,
          lastUpdate: Date.now(),
          active: true,
        },
      },
    });
  },

  appendThinking: (sessionId, actorId, delta) => {
    if (!delta) return;
    const key = k(sessionId, actorId);
    const existing = get().byKey[key] ?? emptyEntry(sessionId, actorId);
    set({
      byKey: {
        ...get().byKey,
        [key]: {
          ...existing,
          thinkingText: existing.thinkingText + delta,
          lastUpdate: Date.now(),
          active: true,
        },
      },
    });
  },

  pushToolUse: (sessionId, actorId, { toolId, toolName, description, params }) => {
    if (!toolId) return;
    const key = k(sessionId, actorId);
    const existing = get().byKey[key] ?? emptyEntry(sessionId, actorId);
    // Skip if already present (dedup on retry / replay)
    if (existing.toolCalls.some((tc) => tc.id === toolId)) return;
    const newToolCall: ToolCall = {
      id: toolId,
      name: toolName || "unknown",
      status: "calling",
      arguments: { ...(params ?? {}), ...(description ? { _description: description } : {}) },
      startTime: new Date(),
    };
    set({
      byKey: {
        ...get().byKey,
        [key]: {
          ...existing,
          toolCalls: [...existing.toolCalls, newToolCall],
          lastUpdate: Date.now(),
          active: true,
        },
      },
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

  clearActor: (sessionId, actorId) => {
    const key = k(sessionId, actorId);
    const next = { ...get().byKey };
    delete next[key];
    set({ byKey: next });
  },

  clearSession: (sessionId) => {
    const next: Record<string, AgentStreamEntry> = {};
    for (const [key, entry] of Object.entries(get().byKey)) {
      if (entry.sessionId !== sessionId) next[key] = entry;
    }
    set({ byKey: next });
  },
}));

/** Selector helper: get all streaming entries for a session. */
export function selectStreamsForSession(state: State, sessionId: string): AgentStreamEntry[] {
  return Object.values(state.byKey).filter((e) => e.sessionId === sessionId && e.active);
}
