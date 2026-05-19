import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef } from "react";
import {
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { Hairline } from "../../../ui/atoms/Hairline";
import { StatusDot } from "../../../ui/atoms/StatusDot";
import { colors, hai, spacing, typography } from "../../../ui/theme";
import {
  AgentChipBar,
  type AgentChip,
} from "../components/AgentChipBar";
import { ConnectionBannerOverlay } from "../components/ConnectionBannerOverlay";
import { MentionsPopup } from "../components/MentionsPopup";
import {
  applyMention,
  filterMentionCandidates,
  mentionQuery,
  type MentionTarget,
} from "../components/mentions";
import { SessionComposerShell } from "../components/SessionComposerShell";
import { SessionMessageRow } from "../components/SessionMessageRow";
import { SlashCommandsPopup } from "../components/SlashCommandsPopup";
import {
  filterSlashCommands,
  SLASH_COMMANDS,
  slashPrefix,
} from "../components/slash-commands";
import { TodoDock } from "../components/TodoDock";
import type {
  SessionDetailConnectionState,
  SessionDetailControllerState,
} from "../session-detail-controller";
import type { SessionSummary } from "../session-types";

type SessionDetailRenderableState = SessionDetailControllerState & {
  status: "empty" | "ready" | "error";
  session: SessionSummary;
};

type SessionDetailScreenProps = {
  agentChips?: AgentChip[];
  composerText: string;
  connectionState: SessionDetailConnectionState;
  headerAvatars?: ReadonlyArray<{ actorId: string; avatarUrl?: string | null; initial: string }>;
  isSending: boolean;
  mentionPool?: ReadonlyArray<MentionTarget>;
  onAgentInterrupt?: (agentId: string) => void;
  onAgentRemove?: (agentId: string) => void;
  onAttach?: () => void;
  onBack: () => void;
  onChangeComposerText: (value: string) => void;
  onClearReply?: () => void;
  onDeleteMessage?: (messageId: string) => void;
  onEditMessage?: (messageId: string, currentContent: string) => void;
  onOpenMembers?: () => void;
  onReplyToMessage?: (messageId: string) => void;
  onSend: () => void;
  ownActorId?: string;
  replyTarget?: { messageId: string; content: string } | null;
  senderNames?: ReadonlyMap<string, string>;
  sendErrorMessage: string | null;
  state: SessionDetailRenderableState;
  streamingAgentIds?: ReadonlySet<string>;
  todoText?: string;
};

function connectionDescriptor(
  state: SessionDetailConnectionState,
): { dot: "active" | "idle" | "error"; label: string } {
  switch (state) {
    case "connected":
      return { dot: "active", label: "Live" };
    case "connecting":
      return { dot: "idle", label: "Connecting" };
    case "disconnected":
    default:
      return { dot: "error", label: "Offline" };
  }
}

function SessionHeader({
  connectionState,
  headerAvatars,
  onBack,
  onOpenMembers,
  session,
}: {
  connectionState: SessionDetailConnectionState;
  headerAvatars?: ReadonlyArray<{ actorId: string; avatarUrl?: string | null; initial: string }>;
  onBack: () => void;
  onOpenMembers?: () => void;
  session: SessionSummary;
}) {
  const title = session.title.trim() || "Untitled session";
  const status = connectionDescriptor(connectionState);

  return (
    <View>
      <View style={styles.headerBar}>
        <Pressable hitSlop={8} onPress={onBack} style={styles.headerSlot}>
          <Ionicons name="chevron-back" size={26} color={colors.onyx} />
        </Pressable>
        {headerAvatars && headerAvatars.length > 0 ? (
          <View style={styles.headerAvatars}>
            {headerAvatars.slice(0, 3).map((avatar, index) => (
              <View
                key={avatar.actorId}
                style={[styles.headerAvatarTile, { marginLeft: index === 0 ? 0 : -8 }]}
              >
                {avatar.avatarUrl ? (
                  <Image
                    accessibilityRole="image"
                    source={{ uri: avatar.avatarUrl }}
                    style={styles.headerAvatarImage}
                  />
                ) : (
                  <Text style={styles.headerAvatarInitial}>{avatar.initial}</Text>
                )}
              </View>
            ))}
          </View>
        ) : null}
        <View style={styles.headerTitleBlock}>
          <Text numberOfLines={1} style={styles.headerTitle}>
            {title}
          </Text>
          <View style={styles.headerStatus}>
            <StatusDot kind={status.dot} size={6} />
            <Text style={styles.headerStatusLabel}>{status.label}</Text>
            <Text style={styles.headerSeparator}>·</Text>
            <Text style={styles.headerStatusLabel}>
              {session.participantCount}{" "}
              {session.participantCount === 1 ? "actor" : "actors"}
            </Text>
          </View>
        </View>
        <Pressable hitSlop={8} onPress={onOpenMembers} style={styles.headerSlot}>
          <Ionicons
            name="people-outline"
            size={22}
            color={onOpenMembers ? colors.onyx : colors.slate}
          />
        </Pressable>
      </View>
      <Hairline />
    </View>
  );
}

export function SessionDetailScreen(props: SessionDetailScreenProps) {
  const {
    agentChips,
    composerText,
    connectionState,
    headerAvatars,
    isSending,
    mentionPool,
    onAgentInterrupt,
    onAgentRemove,
    onAttach,
    onBack,
    onChangeComposerText,
    onClearReply,
    onDeleteMessage,
    onEditMessage,
    onOpenMembers,
    onReplyToMessage,
    onSend,
    ownActorId,
    replyTarget,
    senderNames,
    sendErrorMessage,
    streamingAgentIds,
    todoText,
    state,
  } = props;
  const { session } = state;
  const hasMessages = state.messages.length > 0;
  const messageListRef = useRef<FlatList<typeof state.messages[number]> | null>(null);
  const lastMessageCount = useRef(state.messages.length);

  useEffect(() => {
    if (state.messages.length > lastMessageCount.current) {
      // New message appended — scroll to the bottom so the user sees
      // the latest reply without manually paging down.
      requestAnimationFrame(() => {
        messageListRef.current?.scrollToEnd({ animated: true });
      });
    }
    lastMessageCount.current = state.messages.length;
  }, [state.messages.length]);

  return (
    <View style={styles.screen}>
      <SessionHeader
        connectionState={connectionState}
        headerAvatars={headerAvatars}
        onBack={onBack}
        onOpenMembers={onOpenMembers}
        session={session}
      />
      <ConnectionBannerOverlay connectionState={connectionState} />

      {state.status === "error" ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>{state.errorMessage}</Text>
        </View>
      ) : null}

      <View style={styles.feed}>
        {hasMessages ? (
          <FlatList
            contentContainerStyle={styles.feedContent}
            data={state.messages}
            keyExtractor={(message) => message.messageId}
            onContentSizeChange={() => {
              messageListRef.current?.scrollToEnd({ animated: false });
            }}
            ref={messageListRef}
            renderItem={({ item }) => {
              const isOwn = ownActorId ? item.senderActorId === ownActorId : false;
              const replyToMessage =
                item.replyToMessageId && item.replyToMessageId.length > 0
                  ? state.messages.find((m) => m.messageId === item.replyToMessageId) ?? null
                  : null;
              return (
                <SessionMessageRow
                  isOwnMessage={isOwn}
                  message={item}
                  onDelete={onDeleteMessage}
                  onEdit={
                    onEditMessage
                      ? (msg) => onEditMessage(msg.messageId, msg.content)
                      : undefined
                  }
                  onJumpToReply={(targetId) => {
                    const index = state.messages.findIndex(
                      (m) => m.messageId === targetId,
                    );
                    if (index >= 0) {
                      messageListRef.current?.scrollToIndex({
                        animated: true,
                        index,
                        viewPosition: 0.3,
                      });
                    }
                  }}
                  onReply={
                    onReplyToMessage
                      ? (msg) => onReplyToMessage(msg.messageId)
                      : undefined
                  }
                  replyToMessage={replyToMessage}
                  senderName={
                    !isOwn ? senderNames?.get(item.senderActorId) ?? undefined : undefined
                  }
                />
              );
            }}
          />
        ) : (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No messages yet</Text>
            <Text style={styles.emptyBody}>
              Be the first to write in this session.
            </Text>
          </View>
        )}
      </View>

      {replyTarget ? (
        <View style={styles.replyBar}>
          <View style={styles.replyBarAccent} />
          <View style={styles.replyBarBody}>
            <Text style={styles.replyBarLabel}>Replying to message</Text>
            <Text numberOfLines={1} style={styles.replyBarPreview}>
              {replyTarget.content || "(empty message)"}
            </Text>
          </View>
          {onClearReply ? (
            <Pressable hitSlop={6} onPress={onClearReply} style={styles.replyBarClose}>
              <Ionicons color={colors.slate} name="close" size={16} />
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {todoText ? <TodoDock text={todoText} /> : null}

      {(() => {
        const prefix = slashPrefix(composerText);
        if (prefix === null) return null;
        const candidates = filterSlashCommands(SLASH_COMMANDS, prefix);
        return (
          <SlashCommandsPopup
            candidates={candidates}
            onSelect={(command) => {
              onChangeComposerText(`/${command.name} `);
            }}
          />
        );
      })()}

      {(() => {
        if (!mentionPool || mentionPool.length === 0) return null;
        const query = mentionQuery(composerText);
        if (query === null) return null;
        const candidates = filterMentionCandidates(mentionPool, query);
        return (
          <MentionsPopup
            candidates={candidates}
            onSelect={(target) => onChangeComposerText(applyMention(composerText, target))}
          />
        );
      })()}

      {agentChips && agentChips.length > 0 ? (
        <AgentChipBar
          chips={agentChips}
          onInterrupt={onAgentInterrupt}
          onRemove={onAgentRemove}
          streamingAgentIds={streamingAgentIds}
        />
      ) : null}

      <SessionComposerShell
        composerText={composerText}
        connectionState={connectionState}
        isSending={isSending}
        onAttach={onAttach}
        onChangeText={onChangeComposerText}
        onSend={onSend}
        sendErrorMessage={sendErrorMessage}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  empty: {
    alignItems: "center",
    flex: 1,
    gap: spacing.xs,
    justifyContent: "center",
    paddingHorizontal: spacing.xxl,
  },
  emptyBody: {
    color: colors.basalt,
    textAlign: "center",
    ...typography.secondaryBody,
  },
  emptyTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
  errorBanner: {
    backgroundColor: "rgba(184,75,54,0.10)",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  errorBannerText: {
    color: colors.cinnabarDeep,
    ...typography.caption,
  },
  feed: {
    flex: 1,
  },
  feedContent: {
    paddingVertical: spacing.sm,
  },
  headerBar: {
    alignItems: "center",
    backgroundColor: colors.mist,
    flexDirection: "row",
    minHeight: 48,
    paddingHorizontal: spacing.xs,
  },
  headerSeparator: {
    color: colors.slate,
    paddingHorizontal: 2,
    ...typography.caption,
  },
  headerAvatarImage: {
    height: "100%",
    width: "100%",
  },
  headerAvatarInitial: {
    color: hai.paper,
    fontSize: 10,
    fontWeight: "700",
  },
  headerAvatarTile: {
    alignItems: "center",
    backgroundColor: hai.basalt,
    borderColor: colors.mist,
    borderRadius: 999,
    borderWidth: 1.5,
    height: 22,
    justifyContent: "center",
    overflow: "hidden",
    width: 22,
  },
  headerAvatars: {
    alignItems: "center",
    flexDirection: "row",
    marginLeft: 4,
    marginRight: 8,
  },
  headerSlot: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 40,
    minWidth: 40,
  },
  replyBar: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderTopColor: colors.hairline,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: spacing.lg,
    paddingVertical: 8,
  },
  replyBarAccent: {
    backgroundColor: hai.cinnabar,
    borderRadius: 2,
    height: 28,
    width: 3,
  },
  replyBarBody: {
    flex: 1,
    gap: 1,
  },
  replyBarClose: {
    padding: 4,
  },
  replyBarLabel: {
    color: hai.cinnabar,
    ...typography.caption,
    fontWeight: "700",
  },
  replyBarPreview: {
    color: colors.basalt,
    ...typography.caption,
  },
  headerStatus: {
    alignItems: "center",
    flexDirection: "row",
    gap: 5,
    marginTop: 1,
  },
  headerStatusLabel: {
    color: colors.slate,
    ...typography.caption,
  },
  headerTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
  headerTitleBlock: {
    alignItems: "center",
    flex: 1,
    paddingHorizontal: spacing.xs,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
});
