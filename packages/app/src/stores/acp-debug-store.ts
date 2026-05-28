import { create } from "zustand";
import type { AcpEvent } from "@/lib/proto/amux_pb";

const MAX_LINES = 400;

export type AcpDebugLine = {
  id: string;
  ts: number;
  sessionId: string;
  topic: string;
  actorId: string;
  eventCase: string;
  payload: unknown;
};

function serializeAcpPayload(event: AcpEvent | undefined): unknown {
  if (!event?.event) return null;
  const { case: eventCase, value } = event.event;
  if (!eventCase) return null;
  try {
    return JSON.parse(
      JSON.stringify(
        { case: eventCase, value, model: event.model ?? "" },
        (_key, v) => (typeof v === "bigint" ? v.toString() : v),
      ),
    );
  } catch {
    return { case: eventCase, value: String(value) };
  }
}

interface State {
  lines: AcpDebugLine[];
  enabled: boolean;
  append: (input: {
    sessionId?: string;
    topic: string;
    actorId?: string;
    /** e.g. live:acp.event, runtime_state, client:runtime_start */
    eventCase?: string;
    acpEvent?: AcpEvent;
    envelopeMeta?: Record<string, unknown>;
    payload?: unknown;
  }) => void;
  clear: () => void;
  setEnabled: (enabled: boolean) => void;
}

export const useAcpDebugStore = create<State>((set, get) => ({
  lines: [],
  enabled: import.meta.env.DEV || import.meta.env.VITE_ACP_DEBUG_STREAM === "true",
  append: (input) => {
    if (!get().enabled) return;
    const line: AcpDebugLine = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      sessionId: input.sessionId ?? "",
      topic: input.topic,
      actorId: input.actorId ?? "",
      eventCase:
        input.eventCase ??
        (input.acpEvent?.event?.case ? `live:${input.acpEvent.event.case}` : "(none)"),
      payload:
        input.payload ??
        (input.envelopeMeta
          ? { envelope: input.envelopeMeta, acp: serializeAcpPayload(input.acpEvent) }
          : serializeAcpPayload(input.acpEvent)),
    };
    set((state) => {
      const next = [...state.lines, line];
      if (next.length > MAX_LINES) next.splice(0, next.length - MAX_LINES);
      return { lines: next };
    });
  },
  clear: () => set({ lines: [] }),
  setEnabled: (enabled) => set({ enabled }),
}));

export function isAcpDebugPanelVisible(): boolean {
  return import.meta.env.DEV || import.meta.env.VITE_ACP_DEBUG_STREAM === "true";
}
