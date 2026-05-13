import { create } from "zustand";
import type { AttachedAgent } from "@/packages/ai/prompt-input-insert-hooks";

/** Per-session engaged agent: the one currently selected in the prompt
 * input's bottom-left dropdown. Persists across session switches so
 * coming back to a session restores its agent. */
interface State {
  bySession: Record<string, AttachedAgent | null>;
  setEngagedAgent: (sessionId: string, agent: AttachedAgent | null) => void;
  clearSession: (sessionId: string) => void;
  /** Lookup helper. Returns null for unknown sessionId or null sessionId. */
  get: (sessionId: string | null) => AttachedAgent | null;
}

export const useEngagedAgentStore = create<State>((set, getState) => ({
  bySession: {},
  setEngagedAgent: (sessionId, agent) =>
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: agent } })),
  clearSession: (sessionId) =>
    set((s) => {
      const next = { ...s.bySession };
      delete next[sessionId];
      return { bySession: next };
    }),
  get: (sessionId) =>
    sessionId ? getState().bySession[sessionId] ?? null : null,
}));
