import type {
  SessionMessage,
  StreamingBuffer,
  TimelineEvent,
} from "./session-types";

export type TimelineState = {
  messages: SessionMessage[];
  streamingByAgent: Map<string, StreamingBuffer>;
};

export function emptyTimelineState(): TimelineState {
  return { messages: [], streamingByAgent: new Map() };
}

function timeValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function insertSorted(messages: SessionMessage[], next: SessionMessage): SessionMessage[] {
  const idx = messages.findIndex((m) => m.messageId === next.messageId);
  if (idx >= 0) {
    if (next.content.length > messages[idx].content.length) {
      const out = messages.slice();
      out[idx] = next;
      return out;
    }
    return messages;
  }
  const out = [...messages, next];
  out.sort((a, b) => {
    const dt = timeValue(a.createdAt) - timeValue(b.createdAt);
    if (dt !== 0) return dt;
    return a.messageId.localeCompare(b.messageId);
  });
  return out;
}

function clearStreamingByMessageId(
  streamingByAgent: Map<string, StreamingBuffer>,
  messageId: string,
): Map<string, StreamingBuffer> {
  let changed = false;
  const next = new Map(streamingByAgent);
  for (const [agentId, buf] of next) {
    if (buf.messageId === messageId) {
      next.delete(agentId);
      changed = true;
    }
  }
  return changed ? next : streamingByAgent;
}

export function reduceTimeline(state: TimelineState, event: TimelineEvent): TimelineState {
  switch (event.kind) {
    case "messageCommitted": {
      const messages = insertSorted(state.messages, event.message);
      const streamingByAgent = clearStreamingByMessageId(
        state.streamingByAgent,
        event.message.messageId,
      );
      if (messages === state.messages && streamingByAgent === state.streamingByAgent) {
        return state;
      }
      return { messages, streamingByAgent };
    }
    case "streamingDelta":
    case "streamingDone":
      return state;
  }
}
