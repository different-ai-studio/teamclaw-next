import { create } from "zustand";
import type { Message } from "@/lib/proto/teamclaw_pb";
import { useSessionListStore } from "./session-list-store";
import { useSessionSelectionStore } from "./session-selection-store";

const EMPTY_MESSAGES: Message[] = [];

type SessionMessageState = {
  messages: Record<string, Message[]>;
  messageRefreshTrigger: number;
  appendMessage: (sessionId: string, message: Message) => void;
  setMessages: (sessionId: string, messages: Message[]) => void;
  currentMessages: () => Message[];
  reloadActiveSessionMessages: () => Promise<void>;
};

export const useSessionMessageStore = create<SessionMessageState>((set, get) => ({
  messages: {},
  messageRefreshTrigger: 0,
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
  reloadActiveSessionMessages: async () => {
    await useSessionListStore.getState().load();
    set({ messageRefreshTrigger: get().messageRefreshTrigger + 1 });
  },
}));
