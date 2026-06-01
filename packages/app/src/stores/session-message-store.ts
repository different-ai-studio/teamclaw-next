import { create } from "zustand";
import type { Message } from "@/lib/proto/teamclaw_pb";
import { useSessionSelectionStore } from "./session-selection-store";

const EMPTY_MESSAGES: Message[] = [];

type SessionMessageState = {
  messages: Record<string, Message[]>;
  messageRefreshTrigger: number;
  /** When true, the next App.tsx history load uses a full cloud/cache sync. */
  messageRefreshForceFull: boolean;
  appendMessage: (sessionId: string, message: Message) => void;
  setMessages: (sessionId: string, messages: Message[]) => void;
  currentMessages: () => Message[];
  reloadActiveSessionMessages: (opts?: { full?: boolean }) => Promise<void>;
};

export const useSessionMessageStore = create<SessionMessageState>((set, get) => ({
  messages: {},
  messageRefreshTrigger: 0,
  messageRefreshForceFull: false,
  appendMessage: (sessionId, message) => {
    const cur = get().messages[sessionId] ?? [];
    if (cur.some((m) => m.messageId === message.messageId)) return;
    set({ messages: { ...get().messages, [sessionId]: [...cur, message] } });
  },
  setMessages: (sessionId, messages) => {
    set({ messages: { ...get().messages, [sessionId]: messages } });
  },
  currentMessages: () => {
    const sessionId = useSessionSelectionStore.getState().currentSessionId;
    if (!sessionId) return EMPTY_MESSAGES;
    return get().messages[sessionId] ?? EMPTY_MESSAGES;
  },
  reloadActiveSessionMessages: async (opts) => {
    set({
      messageRefreshTrigger: get().messageRefreshTrigger + 1,
      messageRefreshForceFull: opts?.full ?? false,
    });
  },
}));
