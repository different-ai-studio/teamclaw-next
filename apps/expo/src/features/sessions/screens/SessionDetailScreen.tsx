import { FlatList, ScrollView, StyleSheet, Text, View } from "react-native";

import type {
  SessionDetailConnectionState,
  SessionDetailControllerState,
} from "../session-detail-controller";
import type { SessionDetailState, SessionSummary } from "../session-types";
import { SessionMessageRow } from "../components/SessionMessageRow";
import { SessionComposerShell } from "../components/SessionComposerShell";
import { PrimaryButton } from "../../../ui/button";
import { AppCard } from "../../../ui/card";
import { colors, spacing, typography } from "../../../ui/theme";

type SessionDetailRenderableState = SessionDetailControllerState & {
  status: "empty" | "ready" | "error";
  session: SessionSummary;
};

type SessionDetailScreenProps = {
  composerText: string;
  connectionState: SessionDetailConnectionState;
  isSending: boolean;
  onBack: () => void;
  onChangeComposerText: (value: string) => void;
  onSend: () => void;
  ownActorId?: string;
  sendErrorMessage: string | null;
  state: SessionDetailRenderableState;
};

function formatTimestamp(value: string): string {
  if (!value) {
    return "时间未知";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "时间未知";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    hour12: false,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function SessionDetailScreen(props: SessionDetailScreenProps) {
  const { onBack, ownActorId, state } = props;
  const { composerText, connectionState, isSending, onChangeComposerText, onSend, sendErrorMessage } =
    props;
  const { session } = state;
  const title = session.title.trim() || "未命名会话";
  const updatedAt = session.lastMessageAt || session.createdAt;
  const hasMessages = state.messages.length > 0;

  if (!hasMessages) {
    return (
      <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
        <View style={styles.staticContent}>
          <View style={styles.header}>
            <Text style={styles.eyebrow}>会话详情</Text>
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.meta}>
              {session.participantCount} 位参与者 · {formatTimestamp(updatedAt)}
            </Text>
          </View>

          <AppCard style={styles.card}>
            <Text style={styles.cardTitle}>会话元数据</Text>
            <View style={styles.metaGrid}>
              <Text style={styles.metaLabel}>参与者</Text>
              <Text style={styles.metaValue}>{session.participantCount} 位</Text>
              <Text style={styles.metaLabel}>创建时间</Text>
              <Text style={styles.metaValue}>{formatTimestamp(session.createdAt)}</Text>
              <Text style={styles.metaLabel}>更新时间</Text>
              <Text style={styles.metaValue}>{formatTimestamp(updatedAt)}</Text>
              <Text style={styles.metaLabel}>会话 ID</Text>
              <Text selectable style={styles.metaValue}>
                {session.sessionId}
              </Text>
            </View>
          </AppCard>

          <AppCard elevated style={styles.stateCard}>
            <Text style={styles.cardTitle}>
              {state.status === "empty" ? "还没有消息" : "消息暂时无法加载"}
            </Text>
            <Text style={styles.body}>
              {state.status === "empty"
                ? "这个会话目前还没有聊天记录。"
                : state.errorMessage}
            </Text>
            <PrimaryButton fullWidth={false} label="返回会话列表" onPress={onBack} />
          </AppCard>

          <SessionComposerShell
            composerText={composerText}
            connectionState={connectionState}
            isSending={isSending}
            onChangeText={onChangeComposerText}
            onSend={onSend}
            sendErrorMessage={sendErrorMessage}
          />
        </View>
      </ScrollView>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={styles.eyebrow}>会话详情</Text>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.meta}>
            {session.participantCount} 位参与者 · {formatTimestamp(updatedAt)}
          </Text>
        </View>

        <AppCard style={styles.card}>
          <Text style={styles.cardTitle}>会话元数据</Text>
          <View style={styles.metaGrid}>
            <Text style={styles.metaLabel}>参与者</Text>
            <Text style={styles.metaValue}>{session.participantCount} 位</Text>
            <Text style={styles.metaLabel}>创建时间</Text>
            <Text style={styles.metaValue}>{formatTimestamp(session.createdAt)}</Text>
            <Text style={styles.metaLabel}>更新时间</Text>
            <Text style={styles.metaValue}>{formatTimestamp(updatedAt)}</Text>
            <Text style={styles.metaLabel}>会话 ID</Text>
            <Text selectable style={styles.metaValue}>
              {session.sessionId}
            </Text>
          </View>
        </AppCard>

        {state.status === "error" ? (
          <AppCard elevated style={styles.stateCard}>
            <Text style={styles.cardTitle}>消息暂时无法加载</Text>
            <Text style={styles.body}>{state.errorMessage}</Text>
          </AppCard>
        ) : null}

        <View style={styles.timelineSection}>
          <View style={styles.timelineHeader}>
            <Text style={styles.cardTitle}>消息时间线</Text>
            <Text style={styles.timelineCount}>{state.messages.length} 条</Text>
          </View>
          <AppCard style={styles.timelineCard}>
            <FlatList
              contentContainerStyle={styles.timelineContent}
              data={state.messages}
              keyExtractor={(message) => message.messageId}
              renderItem={({ item }) => (
                <SessionMessageRow
                  isOwnMessage={ownActorId ? item.senderActorId === ownActorId : false}
                  message={item}
                />
              )}
              style={styles.timelineList}
            />
          </AppCard>
          <SessionComposerShell
            composerText={composerText}
            connectionState={connectionState}
            isSending={isSending}
            onChangeText={onChangeComposerText}
            onSend={onSend}
            sendErrorMessage={sendErrorMessage}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    color: colors.ink2,
    ...typography.body,
  },
  card: {
    gap: spacing.sm,
  },
  cardTitle: {
    color: colors.foreground,
    ...typography.cardTitle,
  },
  content: {
    flex: 1,
    gap: spacing.lg,
    padding: spacing.xxl,
  },
  eyebrow: {
    color: colors.faint,
    ...typography.monoMeta,
  },
  header: {
    gap: spacing.xs,
  },
  meta: {
    color: colors.mutedForeground,
    ...typography.meta,
  },
  metaGrid: {
    borderTopColor: colors.borderSoft,
    borderTopWidth: 1,
    columnGap: spacing.md,
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    paddingTop: spacing.sm,
    rowGap: spacing.sm,
  },
  metaLabel: {
    color: colors.mutedForeground,
    minWidth: 64,
    ...typography.meta,
  },
  metaValue: {
    color: colors.foreground,
    flexShrink: 1,
    width: "70%",
    ...typography.monoMeta,
  },
  screen: {
    backgroundColor: colors.background,
    flex: 1,
  },
  staticContent: {
    gap: spacing.lg,
  },
  stateCard: {
    gap: spacing.md,
  },
  timelineCard: {
    flex: 1,
    gap: spacing.sm,
    paddingHorizontal: 0,
    paddingVertical: spacing.sm,
  },
  timelineCount: {
    color: colors.faint,
    ...typography.monoMeta,
  },
  timelineHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  timelineContent: {
    paddingVertical: spacing.xs,
  },
  timelineList: {
    flex: 1,
  },
  timelineSection: {
    flex: 1,
    gap: spacing.md,
    minHeight: 0,
  },
  title: {
    color: colors.foreground,
    ...typography.sectionTitle,
  },
});
