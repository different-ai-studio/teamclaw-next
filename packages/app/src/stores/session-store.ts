import { create } from "zustand";
import type { Message } from "@/lib/proto/teamclaw_pb";

interface SessionState {
  messages: Record<string, Message[]>;
  currentSessionId: string | null;
  setCurrent: (sid: string | null) => void;
  appendMessage: (sid: string, msg: Message) => void;
  setMessages: (sid: string, msgs: Message[]) => void;
  currentMessages: () => Message[];
}

export const useSessionStore = create<SessionState>((set, get) => ({
  messages: {},
  currentSessionId: null,
  setCurrent: (sid) => set({ currentSessionId: sid }),
  appendMessage: (sid, msg) => {
    const cur = get().messages[sid] ?? [];
    if (cur.some((m) => m.messageId === msg.messageId)) return;
    set({ messages: { ...get().messages, [sid]: [...cur, msg] } });
  },
  setMessages: (sid, msgs) => set({ messages: { ...get().messages, [sid]: msgs } }),
  currentMessages: () => {
    const sid = get().currentSessionId;
    return sid ? (get().messages[sid] ?? []) : [];
  },
}));
