import { create } from "zustand";
import type { AttachedAgent } from "@/packages/ai/prompt-input-insert-hooks";

/** Per-session engaged agents. The prompt-input toolbar renders one pill
 * per agent in this list; @-mention from the input pushes onto the list,
 * removing the pill (or "Remove" inside its dropdown) pops it back off. */
interface State {
  bySession: Record<string, AttachedAgent[]>;
  /** Replace the engaged-agents list for a session. */
  setAgents: (sessionId: string, agents: AttachedAgent[]) => void;
  /** Add an agent (dedup by id). Used by @-mention. */
  addAgent: (sessionId: string, agent: AttachedAgent) => void;
  /** Remove an agent by id. */
  removeAgent: (sessionId: string, agentId: string) => void;
  /** Drop the whole entry for a session (e.g. on session delete). */
  clearSession: (sessionId: string) => void;
  /** Returns the array (empty if none / unknown sessionId). */
  getAgents: (sessionId: string | null) => AttachedAgent[];
  /** Legacy single-agent accessor — returns the first engaged agent or null.
   * Use {@link getAgents} for the full set when routing/rendering. */
  get: (sessionId: string | null) => AttachedAgent | null;
  /** Legacy setter that replaces the list with [agent] (or clears when null). */
  setEngagedAgent: (sessionId: string, agent: AttachedAgent | null) => void;
}

export const useEngagedAgentStore = create<State>((set, getState) => ({
  bySession: {},
  setAgents: (sessionId, agents) =>
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: agents } })),
  addAgent: (sessionId, agent) =>
    set((s) => {
      const prev = s.bySession[sessionId] ?? [];
      if (prev.some((a) => a.id === agent.id)) return s;
      return { bySession: { ...s.bySession, [sessionId]: [...prev, agent] } };
    }),
  removeAgent: (sessionId, agentId) =>
    set((s) => {
      const prev = s.bySession[sessionId];
      if (!prev || prev.length === 0) return s;
      const next = prev.filter((a) => a.id !== agentId);
      if (next.length === prev.length) return s;
      return { bySession: { ...s.bySession, [sessionId]: next } };
    }),
  clearSession: (sessionId) =>
    set((s) => {
      const next = { ...s.bySession };
      delete next[sessionId];
      return { bySession: next };
    }),
  getAgents: (sessionId) =>
    sessionId ? getState().bySession[sessionId] ?? [] : [],
  get: (sessionId) => {
    if (!sessionId) return null;
    const arr = getState().bySession[sessionId];
    return arr && arr.length > 0 ? arr[0] : null;
  },
  setEngagedAgent: (sessionId, agent) =>
    set((s) => ({
      bySession: {
        ...s.bySession,
        [sessionId]: agent ? [agent] : [],
      },
    })),
}));
