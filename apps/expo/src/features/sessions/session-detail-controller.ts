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
import { takePendingAttachments } from "./pending-attachments";
import {
  buildSessionDetailState,
  type SessionDetailState,
  type SessionMessage,
  type SessionSummary,
} from "./session-types";
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
};

type SessionsApi = ReturnType<typeof createSessionsApi>;

type SessionDetailControllerDeps = {
  api: Pick<
    SessionsApi,
    "getSession" | "insertOutgoingMessage" | "listMessages" | "resolveMemberActorId"
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
};

type SessionDetailController = {
  subscribe: (listener: () => void) => () => void;
  getState: () => SessionDetailControllerState;
  load: () => Promise<void>;
  setComposerText: (value: string) => void;
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

function messageTimeValue(message: SessionMessage): number {
  const parsed = Date.parse(message.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeMessage(messages: SessionMessage[], nextMessage: SessionMessage): SessionMessage[] {
  const existingIndex = messages.findIndex((message) => message.messageId === nextMessage.messageId);
  if (existingIndex >= 0) {
    return messages;
  }

  return [...messages, nextMessage].sort((left, right) => {
    const timeDiff = messageTimeValue(left) - messageTimeValue(right);
    if (timeDiff !== 0) {
      return timeDiff;
    }

    return left.messageId.localeCompare(right.messageId);
  });
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

        const mergedMessages = mergeMessage(state.messages, nextMessage);
        setState({
          ...state,
          messages: mergedMessages,
          status: nextStatusForMessages(state.session, mergedMessages, state.status),
        });
      });

      await deps.mqtt.subscribe(`amux/${deps.teamId}/session/${deps.sessionId}/live`);
      const latestMessages = await deps.api.listMessages(deps.teamId, deps.sessionId);

      if (disposed || currentToken !== loadToken) {
        await disconnectRealtime();
        return;
      }

      const mergedMessages = latestMessages.reduce(mergeMessage, state.messages);

      setState({
        ...state,
        connectionState: "connected",
        messages: mergedMessages,
        status: nextStatusForMessages(state.session, mergedMessages, state.status),
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

      setState({
        ...state,
        status: "loading",
        session: null,
        messages: [],
        errorMessage: null,
        connectionState: "disconnected",
        sendErrorMessage: null,
      });

      const [sessionResult, messagesResult] = await Promise.allSettled([
        deps.api.getSession(deps.teamId, deps.sessionId),
        deps.api.listMessages(deps.teamId, deps.sessionId),
      ]);

      if (disposed || currentToken !== loadToken) {
        return;
      }

      if (sessionResult.status === "rejected") {
        setState({
          ...state,
          status: "error",
          errorMessage: toErrorMessage(sessionResult.reason, "加载会话失败。"),
        });
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
          messages: [],
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

      await connectRealtime(session, currentToken);
    },
    setComposerText(value) {
      setState({
        ...state,
        composerText: value,
        sendErrorMessage: null,
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

      try {
        const auth = await deps.getAuth();
        if (!auth.accessToken) {
          throw new Error("实时连接暂时不可用，仍可稍后重试发送。");
        }

        const actorId = await resolveSenderActorId();
        const createdAt = new Date().toISOString();
        const createdAtSeconds = BigInt(Math.floor(Date.parse(createdAt) / 1000));
        const messageId = uuidV4();

        const pendingAttachments = takePendingAttachments(deps.teamId, deps.sessionId);
        const attachmentsPayload = pendingAttachments.length > 0
          ? pendingAttachments.map((row) => ({
              url: row.publicUrl || row.path,
              path: row.path,
              mime: row.mime,
              size: row.size,
            }))
          : undefined;

        await deps.api.insertOutgoingMessage({
          id: messageId,
          teamId: deps.teamId,
          sessionId: deps.sessionId,
          senderActorId: actorId,
          content,
          createdAt,
          metadata: { mention_actor_ids: [] },
          attachments: attachmentsPayload,
        });

        const optimisticMessage: SessionMessage = {
          content,
          createdAt,
          kind: "text",
          messageId,
          metadata: { mention_actor_ids: [] },
          model: "",
          replyToMessageId: "",
          senderActorId: actorId,
          sessionId: deps.sessionId,
          teamId: deps.teamId,
          turnId: "",
        };

        const mergedMessages = mergeMessage(state.messages, optimisticMessage);
        setState({
          ...state,
          messages: mergedMessages,
          status: nextStatusForMessages(session, mergedMessages, state.status),
        });

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
          setState({
            ...state,
            messages: mergedMessages,
            status: nextStatusForMessages(session, mergedMessages, state.status),
            composerText: "",
            isSending: false,
            sendErrorMessage: "消息已写入，但实时分发失败，请稍后刷新确认。",
          });
          return;
        }

        setState({
          ...state,
          messages: mergedMessages,
          status: nextStatusForMessages(session, mergedMessages, state.status),
          composerText: "",
          isSending: false,
          sendErrorMessage: null,
        });
      } catch (error) {
        setState({
          ...state,
          isSending: false,
          sendErrorMessage: toErrorMessage(error, "发送失败。"),
        });
      }
    },
    async dispose() {
      disposed = true;
      await disconnectRealtime();
      setState({
        ...state,
        connectionState: "disconnected",
      });
    },
  };
}
