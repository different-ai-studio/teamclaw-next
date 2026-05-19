import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useRef } from "react";
import {
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
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
import { DaySeparator } from "../components/DaySeparator";
import { dayLabel, isSameCalendarDay } from "../components/day-separator-labels";
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
  onChangeRuntimeModel?: () => void;
  runtimeInfo?: { status: string; currentModel: string | null } | null;
  mentionPool?: ReadonlyArray<MentionTarget>;
  onAgentInterrupt?: (agentId: string) => void;
  onAgentRemove?: (agentId: string) => void;
  onAttach?: () => void;
  onBack: () => void;
  onChangeComposerText: (value: string) => void;
  isRefreshing?: boolean;
  onClearReply?: () => void;
  onDeleteMessage?: (messageId: string) => void;
  onEditMessage?: (messageId: string, currentContent: string) => void;
  onRefresh?: () => void;
  onOpenMembers?: () => void;
  onReplyToMessage?: (messageId: string) => void;
  onSend: () => void;
  onShare?: () => void;
  ownActorId?: string;
  replyTarget?: { messageId: string; content: string } | null;
  senderAvatars?: ReadonlyMap<string, string | null>;
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
  onShare,
  session,
}: {
  connectionState: SessionDetailConnectionState;
  headerAvatars?: ReadonlyArray<{ actorId: string; avatarUrl?: string | null; initial: string }>;
  onBack: () => void;
  onOpenMembers?: () => void;
  onShare?: () => void;
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
        {onShare ? (
          <Pressable hitSlop={8} onPress={onShare} style={styles.headerSlot}>
            <Ionicons color={colors.onyx} name="share-outline" size={20} />
          </Pressable>
        ) : null}
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
    onChangeRuntimeModel,
    onClearReply,
    onDeleteMessage,
    onEditMessage,
    onOpenMembers,
    onRefresh,
    onReplyToMessage,
    onSend,
    onShare,
    ownActorId,
    replyTarget,
    runtimeInfo,
    isRefreshing,
    senderAvatars,
    senderNames,
    sendErrorMessage,
    streamingAgentIds,
    todoText,
    state,
  } = props;
  const { session } = state;
  const hasMessages = state.messages.length > 0;

  type FeedItem =
    | { kind: "separator"; key: string; label: string }
    | { kind: "message"; key: string; message: typeof state.messages[number] };

  const feedItems: FeedItem[] = [];
  for (let i = 0; i < state.messages.length; i += 1) {
    const current = state.messages[i];
    const prev = i > 0 ? state.messages[i - 1] : null;
    if (!prev || !isSameCalendarDay(prev.createdAt, current.createdAt)) {
      feedItems.push({
        kind: "separator",
        key: `sep:${current.messageId}`,
        label: dayLabel(current.createdAt),
      });
    }
    feedItems.push({
      kind: "message",
      key: current.messageId,
      message: current,
    });
  }

  const messageListRef = useRef<FlatList<FeedItem> | null>(null);
  const lastMessageCount = useRef(state.messages.length);

  const separatorIndices = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < feedItems.length; i += 1) {
      if (feedItems[i].kind === "separator") out.push(i);
    }
    return out;
    // feedItems is derived from state.messages each render; safe to depend on length only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.messages.length]);

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
        onShare={onShare}
        session={session}
      />
      <ConnectionBannerOverlay connectionState={connectionState} />
      {runtimeInfo ? (
        <Pressable
          accessibilityRole={onChangeRuntimeModel ? "button" : undefined}
          disabled={!onChangeRuntimeModel}
          onPress={onChangeRuntimeModel}
          style={({ pressed }) => [
            styles.runtimeBar,
            pressed && onChangeRuntimeModel ? styles.runtimeBarPressed : null,
          ]}
        >
          <Text style={styles.runtimeLabel}>
            Runtime · {runtimeInfo.status}
            {runtimeInfo.currentModel ? ` · ${runtimeInfo.currentModel}` : ""}
          </Text>
          {onChangeRuntimeModel ? (
            <Ionicons color={colors.slate} name="chevron-down" size={12} />
          ) : null}
        </Pressable>
      ) : null}

      {state.status === "error" ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>{state.errorMessage}</Text>
        </View>
      ) : null}

      <View style={styles.feed}>
        {hasMessages ? (
          <FlatList
            contentContainerStyle={styles.feedContent}
            data={feedItems}
            keyExtractor={(item) => item.key}
            onContentSizeChange={() => {
              messageListRef.current?.scrollToEnd({ animated: false });
            }}
            refreshControl={
              onRefresh ? (
                <RefreshControl
                  onRefresh={onRefresh}
                  refreshing={Boolean(isRefreshing)}
                  tintColor={colors.slate}
                />
              ) : undefined
            }
            ref={messageListRef}
            stickyHeaderIndices={separatorIndices}
            renderItem={({ item }) => {
              if (item.kind === "separator") {
                return <DaySeparator label={item.label} />;
              }
              const msg = item.message;
              const isOwn = ownActorId ? msg.senderActorId === ownActorId : false;
              const replyToMessage =
                msg.replyToMessageId && msg.replyToMessageId.length > 0
                  ? state.messages.find((m) => m.messageId === msg.replyToMessageId) ??
                    null
                  : null;
              return (
                <SessionMessageRow
                  isOwnMessage={isOwn}
                  message={msg}
                  onDelete={onDeleteMessage}
                  onEdit={
                    onEditMessage
                      ? (m) => onEditMessage(m.messageId, m.content)
                      : undefined
                  }
                  onJumpToReply={(targetId) => {
                    const index = feedItems.findIndex(
                      (entry) => entry.kind === "message" && entry.message.messageId === targetId,
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
                      ? (m) => onReplyToMessage(m.messageId)
                      : undefined
                  }
                  replyToMessage={replyToMessage}
                  senderAvatarUrl={
                    !isOwn ? senderAvatars?.get(msg.senderActorId) ?? null : null
                  }
                  senderName={
                    !isOwn ? senderNames?.get(msg.senderActorId) ?? undefined : undefined
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
              if (command.action === "clear") {
                onChangeComposerText("");
                return;
              }
              if (command.action === "compact") {
                onChangeComposerText(
                  "/compact Please summarize the conversation so far and replace earlier messages with a recap.",
                );
                return;
              }
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

      <KeyboardAvoidingView
        behavior={Platform.select({ ios: "padding", android: undefined })}
        keyboardVerticalOffset={Platform.select({ ios: 8, default: 0 })}
      >
        <SessionComposerShell
          composerText={composerText}
          connectionState={connectionState}
          isSending={isSending}
          onAttach={onAttach}
          onChangeText={onChangeComposerText}
          onSend={onSend}
          sendErrorMessage={sendErrorMessage}
        />
      </KeyboardAvoidingView>
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
  runtimeBar: {
    alignItems: "center",
    backgroundColor: hai.pebble,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: spacing.lg,
    paddingVertical: 4,
  },
  runtimeBarPressed: {
    opacity: 0.7,
  },
  runtimeLabel: {
    color: colors.basalt,
    ...typography.monoMeta,
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
