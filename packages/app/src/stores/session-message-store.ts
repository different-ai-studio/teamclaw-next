import { create } from "zustand";
import type { Message } from "@/lib/proto/teamclaw_pb";
import { MessageKind } from "@/lib/proto/teamclaw_pb";
import { useSessionSelectionStore } from "./session-selection-store";

const EMPTY_MESSAGES: Message[] = [];

type SessionMessageState = {
  messages: Record<string, Message[]>;
  messageRefreshTrigger: number;
  /** When true, the next App.tsx history load uses a full cloud/cache sync. */
  messageRefreshForceFull: boolean;
  appendMessage: (sessionId: string, message: Message) => void;
  /** One synthesized AGENT_REPLY per turn in the in-memory list (daemon may emit many). */
  replaceTurnAgentRepliesInStore: (sessionId: string, message: Message) => void;
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
  replaceTurnAgentRepliesInStore: (sessionId, message) => {
    const turnId = message.turnId?.trim();
    const senderActorId = message.senderActorId?.trim();
    const cur = get().messages[sessionId] ?? [];
    if (!turnId || !senderActorId || message.kind !== MessageKind.AGENT_REPLY) {
      get().appendMessage(sessionId, message);
      return;
    }
    const rest = cur.filter(
      (row) =>
        !(
          row.turnId === turnId &&
          row.senderActorId === senderActorId &&
          row.kind === MessageKind.AGENT_REPLY
        ),
    );
    const withoutSameId = rest.filter((row) => row.messageId !== message.messageId);
    set({ messages: { ...get().messages, [sessionId]: [...withoutSameId, message] } });
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
