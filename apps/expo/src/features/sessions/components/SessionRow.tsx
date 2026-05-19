import { Pressable, StyleSheet, Text, View } from "react-native";

import type { SessionSummary } from "../session-types";
import { actorAvatarColor } from "../../../lib/actor-color";
import { colors, spacing, typography } from "../../../ui/theme";

type SessionRowProps = {
  isActive?: boolean;
  isPinned?: boolean;
  session: SessionSummary;
  onPress?: (session: SessionSummary) => void;
  unreadCount?: number;
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
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatParticipantCount(count: number): string {
  return `${count} 位`;
}

function buildAvatarModels(session: SessionSummary): Array<{ color: string; label: string }> {
  const visibleActorIds = session.participantActorIds.slice(0, 3);

  if (visibleActorIds.length > 0) {
    return visibleActorIds.map((actorId) => ({
      color: actorAvatarColor(actorId).bg,
      label: (actorId.replace(/[^A-Za-z0-9\u4e00-\u9fa5]/g, "")[0] ?? "人").toUpperCase(),
    }));
  }

  const fallbackId = session.createdBy.trim() || session.sessionId;
  return [
    {
      color: actorAvatarColor(fallbackId).bg,
      label: (fallbackId.replace(/[^A-Za-z0-9\u4e00-\u9fa5]/g, "")[0] ?? "人").toUpperCase(),
    },
  ];
}

function AvatarCluster({ count, session }: { count: number; session: SessionSummary }) {
  const avatars = buildAvatarModels(session);

  return (
    <View style={styles.avatarCluster}>
      {avatars.map((avatar, index) => (
        <View
          key={index}
          style={[
            styles.avatarDisc,
            {
              backgroundColor: avatar.color,
              marginLeft: index === 0 ? 0 : -5,
              opacity: 1 - index * 0.15,
            },
          ]}
        >
          <Text style={styles.avatarLetter}>{avatar.label}</Text>
        </View>
      ))}
    </View>
  );
}

export function SessionRow({
  isActive = false,
  isPinned = false,
  session,
  onPress,
  unreadCount = 0,
}: SessionRowProps) {
  const summary = session.lastMessagePreview.trim() || session.summary.trim() || "还没有消息。";
  const title = session.title.trim() || "未命名会话";
  const timeLabel = formatTimestamp(session.lastMessageAt || session.createdAt);
  const participantLabel = formatParticipantCount(session.participantCount);

  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      disabled={!onPress}
      onPress={() => {
        onPress?.(session);
      }}
      style={({ pressed }) => [
        styles.row,
        isActive ? styles.activeRow : null,
        pressed && onPress ? styles.pressed : null,
      ]}
    >
      <View style={[styles.leftBar, isActive ? styles.activeLeftBar : null]} />
      <View style={styles.headerRow}>
        <View style={styles.pinSlot}>
          <Text style={styles.pinText}>{isPinned ? "📌" : " "}</Text>
        </View>
        <Text numberOfLines={1} style={styles.title}>
          {title}
        </Text>
        <Text style={styles.time}>{timeLabel}</Text>
      </View>

      <Text numberOfLines={2} style={styles.summary}>
        {summary}
      </Text>

      <View style={styles.metaRow}>
        <View style={styles.metaLeft}>
          <AvatarCluster count={session.participantCount} session={session} />
          <Text style={styles.participantText}>{participantLabel}</Text>
        </View>
        <View style={styles.metaRight}>
          {unreadCount > 0 ? <Text style={styles.unreadBadge}>{unreadCount}</Text> : null}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  activeLeftBar: {
    backgroundColor: colors.coral,
  },
  activeRow: {
    backgroundColor: colors.paper,
  },
  avatarCluster: {
    alignItems: "center",
    flexDirection: "row",
  },
  avatarDisc: {
    borderColor: colors.paper,
    borderRadius: 999,
    borderWidth: 1,
    height: 16,
    justifyContent: "center",
    alignItems: "center",
    width: 16,
  },
  avatarLetter: {
    color: colors.paper,
    fontSize: 8,
    fontWeight: "700",
    lineHeight: 10,
  },
  headerRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "space-between",
  },
  leftBar: {
    alignSelf: "stretch",
    backgroundColor: "transparent",
    borderRadius: 2,
    width: 2,
  },
  metaLeft: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
  },
  metaRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  metaRight: {
    alignItems: "flex-end",
    minWidth: 22,
  },
  participantText: {
    color: colors.mutedForeground,
    ...typography.meta,
  },
  pinSlot: {
    alignItems: "center",
    justifyContent: "center",
    width: 14,
  },
  pinText: {
    fontSize: 12,
    lineHeight: 14,
  },
  pressed: {
    backgroundColor: "rgba(26,26,20,0.03)",
  },
  row: {
    backgroundColor: "transparent",
    borderRadius: 0,
    gap: spacing.sm,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  summary: {
    color: colors.ink2,
    ...typography.meta,
  },
  time: {
    color: colors.faint,
    ...typography.monoMeta,
  },
  title: {
    color: colors.foreground,
    flex: 1,
    ...typography.cardTitle,
  },
  unreadBadge: {
    backgroundColor: colors.coral,
    borderRadius: 999,
    color: colors.paper,
    minWidth: 18,
    overflow: "hidden",
    paddingHorizontal: 5,
    paddingVertical: 1,
    textAlign: "center",
    ...typography.caption,
  },
});
