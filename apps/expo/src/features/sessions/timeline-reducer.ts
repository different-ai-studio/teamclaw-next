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

export function reduceTimeline(state: TimelineState, event: TimelineEvent): TimelineState {
  throw new Error("not implemented");
}
