import { Ionicons } from "@expo/vector-icons";
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { Hairline } from "../../../ui/atoms/Hairline";
import { StatusDot } from "../../../ui/atoms/StatusDot";
import { colors, spacing, typography } from "../../../ui/theme";
import {
  AgentChipBar,
  type AgentChip,
} from "../components/AgentChipBar";
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
  isSending: boolean;
  mentionPool?: ReadonlyArray<MentionTarget>;
  onAgentInterrupt?: (agentId: string) => void;
  onAgentRemove?: (agentId: string) => void;
  onAttach?: () => void;
  onBack: () => void;
  onChangeComposerText: (value: string) => void;
  onOpenMembers?: () => void;
  onSend: () => void;
  ownActorId?: string;
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
  onBack,
  onOpenMembers,
  session,
}: {
  connectionState: SessionDetailConnectionState;
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
    isSending,
    mentionPool,
    onAgentInterrupt,
    onAgentRemove,
    onAttach,
    onBack,
    onChangeComposerText,
    onOpenMembers,
    onSend,
    ownActorId,
    sendErrorMessage,
    streamingAgentIds,
    todoText,
    state,
  } = props;
  const { session } = state;
  const hasMessages = state.messages.length > 0;

  return (
    <View style={styles.screen}>
      <SessionHeader
        connectionState={connectionState}
        onBack={onBack}
        onOpenMembers={onOpenMembers}
        session={session}
      />

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
            renderItem={({ item }) => (
              <SessionMessageRow
                isOwnMessage={ownActorId ? item.senderActorId === ownActorId : false}
                message={item}
              />
            )}
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
  headerSlot: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 40,
    minWidth: 40,
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
