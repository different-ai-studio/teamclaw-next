import { create, toBinary } from "@bufbuild/protobuf";
import {
  LiveEventEnvelopeSchema,
  MessageKind,
  MessageSchema,
  SessionMessageEnvelopeSchema,
  type Message,
} from "@teamclaw/app/proto/teamclaw_pb";

import { decodeLiveEvent, sessionIdFromTopic } from "../../lib/teamclaw/live-events";
import type { ExpoMqttAdapter } from "../../lib/mqtt/expo-mqtt";
import { uuidV4 } from "../../lib/uuid";
import { setOutboxStatus, syncOutboxFromDao } from "./outbox-store";
import type { OutboxDao } from "./outbox-db";
import type { OutboxSender } from "./outbox-sender";
import { takePendingAttachments } from "./pending-attachments";
import type { SessionDetailCache } from "./session-detail-cache";
import {
  buildSessionDetailState,
  type SessionDetailState,
  type SessionMessage,
  type SessionSummary,
  type StreamingBuffer,
  type TimelineEvent,
} from "./session-types";
import { reduceTimeline, emptyTimelineState, type TimelineState } from "./timeline-reducer";
import { createSessionsApi } from "./session-api";

export type SessionDetailConnectionState = "connecting" | "connected" | "disconnected";

export type SessionDetailControllerState = {
  status: SessionDetailState["status"];
  session: SessionSummary | null;
  messages: SessionMessage[];
  errorMessage: string | null;
  connectionState: SessionDetailConnectionState;
  composerText: string;
  isSending: boolean;
  sendErrorMessage: string | null;
  replyTarget: { messageId: string; content: string } | null;
  streamingByAgent: ReadonlyMap<string, StreamingBuffer>;
};

type SessionsApi = ReturnType<typeof createSessionsApi>;

type SessionDetailControllerDeps = {
  api: Pick<
    SessionsApi,
    | "getSession"
    | "insertOutgoingMessage"
    | "listMessages"
    | "markSessionRead"
    | "resolveMemberActorId"
  >;
  currentMemberActorId: string | null;
  getAuth: () => Promise<{ accessToken: string | null; userId: string | null }>;
  mqtt: Pick<
    ExpoMqttAdapter,
    "connect" | "disconnect" | "publish" | "subscribe" | "onMessage" | "onConnectionState"
  >;
  mqttUrl: string | null;
  sessionId: string;
  teamId: string;
  cache?: SessionDetailCache;
  outbox?: { sender: OutboxSender; dao: OutboxDao };
};

type SessionDetailController = {
  subscribe: (listener: () => void) => () => void;
  getState: () => SessionDetailControllerState;
  load: () => Promise<void>;
  setComposerText: (value: string) => void;
  setReplyTarget: (target: { messageId: string; content: string } | null) => void;
  sendMessage: () => Promise<void>;
  dispose: () => Promise<void>;
};

const initialState: SessionDetailControllerState = {
  status: "loading",
  session: null,
  messages: [],
  errorMessage: null,
  connectionState: "disconnected",
  composerText: "",
  isSending: false,
  sendErrorMessage: null,
  replyTarget: null,
  streamingByAgent: emptyTimelineState().streamingByAgent,
};

function toIsoFromSeconds(value: bigint): string {
  return new Date(Number(value) * 1000).toISOString();
}

function kindToString(kind: MessageKind): string {
  switch (kind) {
    case MessageKind.SYSTEM:
      return "system";
    case MessageKind.AGENT_THINKING:
      return "agent_thinking";
    case MessageKind.AGENT_TOOL_CALL:
      return "agent_tool_call";
    case MessageKind.AGENT_TOOL_RESULT:
      return "agent_tool_result";
    case MessageKind.AGENT_REPLY:
      return "agent_reply";
    case MessageKind.TEXT:
    default:
      return "text";
  }
}

function mapProtoMessage(message: Message, teamId: string): SessionMessage | null {
  if (!message.messageId || !message.sessionId) {
    return null;
  }

  return {
    content: message.content ?? "",
    createdAt: toIsoFromSeconds(message.createdAt),
    kind: kindToString(message.kind),
    messageId: message.messageId,
    metadata: null,
    model: message.model ?? "",
    replyToMessageId: message.replyToMessageId ?? "",
    senderActorId: message.senderActorId ?? "",
    sessionId: message.sessionId,
    teamId,
    turnId: message.turnId ?? "",
  };
}

function nextStatusForMessages(
  session: SessionSummary | null,
  messages: SessionMessage[],
  fallback: SessionDetailControllerState["status"],
): SessionDetailControllerState["status"] {
  if (!session) {
    return fallback;
  }

  return messages.length > 0 ? "ready" : "empty";
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

export function createSessionDetailController(
  deps: SessionDetailControllerDeps,
): SessionDetailController {
  const listeners = new Set<() => void>();
  let state = initialState;
  let timeline: TimelineState = emptyTimelineState();
  let disposed = false;
  let cleanupMessageListener: (() => void) | null = null;
  let cleanupConnectionStateListener: (() => void) | null = null;
  let loadToken = 0;

  function emit() {
    for (const listener of listeners) {
      listener();
    }
  }

  function setState(nextState: SessionDetailControllerState) {
    state = nextState;
    emit();
  }

  async function disconnectRealtime() {
    cleanupConnectionStateListener?.();
    cleanupConnectionStateListener = null;
    cleanupMessageListener?.();
    cleanupMessageListener = null;
    await deps.mqtt.disconnect();
  }

  async function resolveSenderActorId(): Promise<string> {
    if (deps.currentMemberActorId) {
      return deps.currentMemberActorId;
    }

    const auth = await deps.getAuth();
    if (!auth.userId) {
      throw new Error("无法读取当前用户信息。");
    }

    const resolved = await deps.api.resolveMemberActorId(deps.teamId, auth.userId);
    if (!resolved) {
      throw new Error("无法解析当前团队里的成员身份。");
    }

    return resolved;
  }

  async function connectRealtime(session: SessionSummary, currentToken: number) {
    if (!deps.mqttUrl) {
      setState({
        ...state,
        connectionState: "disconnected",
      });
      return;
    }

    const auth = await deps.getAuth();
    if (!auth.accessToken) {
      setState({
        ...state,
        connectionState: "disconnected",
      });
      return;
    }

    const actorId = await resolveSenderActorId();
    if (disposed || currentToken !== loadToken) {
      return;
    }

    try {
      cleanupConnectionStateListener = deps.mqtt.onConnectionState((connectionState) => {
        if (disposed || currentToken !== loadToken) {
          return;
        }

        setState({
          ...state,
          connectionState,
        });
      });

      await deps.mqtt.connect({
        url: deps.mqttUrl,
        options: {
          clean: true,
          clientId: `teamclaw-expo-${actorId.slice(0, 8)}-${uuidV4().slice(0, 8)}`,
          password: auth.accessToken,
          reconnectPeriod: 0,
          username: actorId,
        },
      });

      cleanupMessageListener = deps.mqtt.onMessage((incoming) => {
        if (disposed || sessionIdFromTopic(incoming.topic) !== deps.sessionId) {
          return;
        }

        const decoded = decodeLiveEvent(incoming.payload);
        if (!decoded?.message) {
          return;
        }

        const nextMessage = mapProtoMessage(decoded.message, deps.teamId);
        if (!nextMessage) {
          return;
        }

        const event: TimelineEvent = { kind: "messageCommitted", message: nextMessage };
        const next = reduceTimeline(timeline, event);
        timeline = next;
        setState({
          ...state,
          messages: next.messages,
          streamingByAgent: next.streamingByAgent,
          status: nextStatusForMessages(state.session, next.messages, state.status),
        });
        void deps.cache?.saveMessages(deps.sessionId, next.messages);

        // Live-update the read marker so the Sessions list stays clean
        // while the detail screen is open. We pass the senderActorId
        // through so a future receipts UI can resolve "who's read up
        // to where" without an extra lookup.
        if (
          deps.currentMemberActorId &&
          nextMessage.senderActorId !== deps.currentMemberActorId
        ) {
          void deps.api
            .markSessionRead(deps.sessionId, deps.currentMemberActorId, nextMessage.messageId)
            .catch(() => {
              // best-effort
            });
        }
      });

      await deps.mqtt.subscribe(`amux/${deps.teamId}/session/${deps.sessionId}/live`);
      const latestMessages = await deps.api.listMessages(deps.teamId, deps.sessionId);

      if (disposed || currentToken !== loadToken) {
        await disconnectRealtime();
        return;
      }

      let next = timeline;
      for (const m of latestMessages) {
        next = reduceTimeline(next, { kind: "messageCommitted", message: m });
      }
      timeline = next;

      setState({
        ...state,
        connectionState: "connected",
        messages: next.messages,
        streamingByAgent: next.streamingByAgent,
        status: nextStatusForMessages(state.session, next.messages, state.status),
      });
    } catch (error) {
      if (disposed || currentToken !== loadToken) {
        return;
      }

      console.warn(
        "MQTT realtime connect failed",
        error instanceof Error ? error.message : error,
      );
      setState({
        ...state,
        connectionState: "disconnected",
        sendErrorMessage: state.sendErrorMessage,
      });
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState() {
      return state;
    },
    async load() {
      loadToken += 1;
      const currentToken = loadToken;
      timeline = emptyTimelineState();

      setState({
        ...state,
        status: "loading",
        session: null,
        messages: [],
        errorMessage: null,
        connectionState: "disconnected",
        sendErrorMessage: null,
      });

      deps.outbox?.sender.start();

      // Hydrate from disk first so the user sees the timeline immediately on
      // cold start. The network results below overlay on top once they land.
      if (deps.cache) {
        void deps.cache.load(deps.sessionId).then((cached) => {
          if (disposed || currentToken !== loadToken || !cached) return;
          if (state.session) return; // network beat the disk read
          const detailState = buildSessionDetailState(cached.session, cached.messages);
          setState({
            ...state,
            status: detailState.status,
            session: cached.session,
            messages: detailState.messages,
            errorMessage: null,
          });
        });
      }

      const [sessionResult, messagesResult] = await Promise.allSettled([
        deps.api.getSession(deps.teamId, deps.sessionId),
        deps.api.listMessages(deps.teamId, deps.sessionId),
      ]);

      if (disposed || currentToken !== loadToken) {
        return;
      }

      if (sessionResult.status === "rejected") {
        // If cached rows already paint, keep them and surface the network
        // error inline rather than blanking the screen.
        if (state.session) {
          setState({
            ...state,
            status: "error",
            errorMessage: toErrorMessage(sessionResult.reason, "加载会话失败。"),
          });
        } else {
          setState({
            ...state,
            status: "error",
            errorMessage: toErrorMessage(sessionResult.reason, "加载会话失败。"),
          });
        }
        return;
      }

      const session = sessionResult.value;
      if (!session) {
        setState({
          ...state,
          status: "not-found",
        });
        return;
      }

      if (messagesResult.status === "rejected") {
        setState({
          ...state,
          status: "error",
          session,
          messages: state.messages,
          errorMessage: toErrorMessage(messagesResult.reason, "加载消息失败。"),
        });
        await connectRealtime(session, currentToken);
        return;
      }

      const detailState = buildSessionDetailState(session, messagesResult.value);
      setState({
        ...state,
        status: detailState.status,
        session,
        messages: detailState.messages,
        errorMessage: null,
      });

      // Persist authoritative network state for the next cold start.
      void deps.cache?.save(deps.sessionId, {
        session,
        messages: detailState.messages,
      });

      await connectRealtime(session, currentToken);
    },
    setComposerText(value) {
      setState({
        ...state,
        composerText: value,
        sendErrorMessage: null,
      });
    },
    setReplyTarget(target) {
      setState({
        ...state,
        replyTarget: target,
      });
    },
    async sendMessage() {
      const content = state.composerText.trim();
      const session = state.session;

      if (!content || !session) {
        return;
      }

      if (state.connectionState !== "connected") {
        setState({
          ...state,
          sendErrorMessage:
            state.connectionState === "connecting"
              ? "实时连接准备中，请稍后再试。"
              : "实时连接暂时不可用，仍可稍后重试发送。",
        });
        return;
      }

      setState({
        ...state,
        isSending: true,
        sendErrorMessage: null,
      });

      let outboxMessageId: string | null = null;
      try {
        const auth = await deps.getAuth();
        if (!auth.accessToken) {
          throw new Error("实时连接暂时不可用，仍可稍后重试发送。");
        }

        const actorId = await resolveSenderActorId();
        const createdAt = new Date().toISOString();
        const createdAtSeconds = BigInt(Math.floor(Date.parse(createdAt) / 1000));
        const messageId = uuidV4();
        outboxMessageId = messageId;
        setOutboxStatus(messageId, "sending");

        const pendingAttachments = takePendingAttachments(deps.teamId, deps.sessionId);
        const attachmentsPayload = pendingAttachments.length > 0
          ? pendingAttachments.map((row) => ({
              url: row.publicUrl || row.path,
              path: row.path,
              mime: row.mime,
              size: row.size,
            }))
          : undefined;

        const replyTo = state.replyTarget?.messageId ?? null;

        await deps.api.insertOutgoingMessage({
          id: messageId,
          teamId: deps.teamId,
          sessionId: deps.sessionId,
          senderActorId: actorId,
          content,
          createdAt,
          metadata: { mention_actor_ids: [] },
          attachments: attachmentsPayload,
          replyToMessageId: replyTo,
        });

        const optimisticMessage: SessionMessage = {
          content,
          createdAt,
          kind: "text",
          messageId,
          metadata: { mention_actor_ids: [] },
          model: "",
          replyToMessageId: replyTo ?? "",
          senderActorId: actorId,
          sessionId: deps.sessionId,
          teamId: deps.teamId,
          turnId: "",
        };

        const optimisticNext = reduceTimeline(timeline, { kind: "messageCommitted", message: optimisticMessage });
        timeline = optimisticNext;
        const mergedMessages = optimisticNext.messages;
        setState({
          ...state,
          composerText: "",
          messages: mergedMessages,
          streamingByAgent: optimisticNext.streamingByAgent,
          replyTarget: null,
          status: nextStatusForMessages(session, mergedMessages, state.status),
        });

        if (deps.outbox) {
          await deps.outbox.sender.enqueue({
            messageId,
            sessionId: deps.sessionId,
            teamId: deps.teamId,
            senderActorId: actorId,
            content,
            mentionActorIds: [],
            replyToMessageId: replyTo,
            attachments: pendingAttachments.map((row) => ({
              url: row.publicUrl || row.path,
              path: row.path,
              mime: row.mime,
              size: row.size,
            })),
            createdAt: Date.parse(createdAt),
          });
          await syncOutboxFromDao(deps.outbox.dao, [messageId]);
        } else {
          // Fallback path (existing inline publish)
          const protoMessage = create(MessageSchema, {
            messageId,
            sessionId: deps.sessionId,
            senderActorId: actorId,
            kind: MessageKind.TEXT,
            content,
            createdAt: createdAtSeconds,
          });
          const sessionMessage = create(SessionMessageEnvelopeSchema, {
            message: protoMessage,
            mentionActorIds: [],
          });
          const envelope = create(LiveEventEnvelopeSchema, {
            eventId: uuidV4(),
            eventType: "message.created",
            sessionId: deps.sessionId,
            actorId,
            sentAt: createdAtSeconds,
            body: toBinary(SessionMessageEnvelopeSchema, sessionMessage),
          });

          try {
            await deps.mqtt.publish(
              `amux/${deps.teamId}/session/${deps.sessionId}/live`,
              toBinary(LiveEventEnvelopeSchema, envelope),
              false,
            );
          } catch {
            setOutboxStatus(messageId, "failed");
            setState({
              ...state,
              messages: mergedMessages,
              streamingByAgent: optimisticNext.streamingByAgent,
              status: nextStatusForMessages(session, mergedMessages, state.status),
              composerText: "",
              isSending: false,
              sendErrorMessage: "消息已写入，但实时分发失败，请稍后刷新确认。",
            });
            return;
          }
        }

        setOutboxStatus(messageId, "sent");
        setState({
          ...state,
          messages: mergedMessages,
          streamingByAgent: optimisticNext.streamingByAgent,
          status: nextStatusForMessages(session, mergedMessages, state.status),
          composerText: "",
          isSending: false,
          sendErrorMessage: null,
        });
      } catch (error) {
        if (outboxMessageId) {
          setOutboxStatus(outboxMessageId, "failed");
        }
        setState({
          ...state,
          isSending: false,
          sendErrorMessage: toErrorMessage(error, "发送失败。"),
        });
      }
    },
    async dispose() {
      disposed = true;
      deps.outbox?.sender.stop();
      await disconnectRealtime();
      setState({
        ...state,
        connectionState: "disconnected",
      });
    },
  };
}
