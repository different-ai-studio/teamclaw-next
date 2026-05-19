import { StyleSheet, Text, View } from "react-native";

import type { SessionMessage } from "../session-types";
import { colors, radii, spacing, typography } from "../../../ui/theme";

const NON_DISPLAYABLE_MESSAGE_KINDS = new Set([
  "permission_request",
  "agent_thinking",
  "agent_tool_call",
  "agent_tool_result",
]);

export type SessionMessageRowProps = {
  message: SessionMessage;
  isOwnMessage?: boolean;
};

export function normalizeBody(message: SessionMessage): string {
  const body = message.content.trim();
  if (!body) {
    return "内容为空";
  }

  return body;
}

export function isNonDisplayableKind(kind: string): boolean {
  return NON_DISPLAYABLE_MESSAGE_KINDS.has(kind.trim().toLowerCase());
}

export function formatTimestamp(value: string): string {
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

export function SessionMessageRow({ message, isOwnMessage = false }: SessionMessageRowProps) {
  const body = isNonDisplayableKind(message.kind) ? "暂未在移动端展开此消息类型" : normalizeBody(message);
  const timestamp = formatTimestamp(message.createdAt);

  return (
    <View style={[styles.row, isOwnMessage ? styles.rowOwn : styles.rowOther]}>
      <View style={[styles.surface, isOwnMessage ? styles.surfaceOwn : styles.surfaceOther]}>
        <Text style={[styles.body, isOwnMessage ? styles.bodyOwn : styles.bodyOther]}>{body}</Text>
        <Text style={[styles.time, isOwnMessage ? styles.metaOwn : styles.metaOther]}>{timestamp}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    ...typography.body,
  },
  bodyOther: {
    color: colors.foreground,
  },
  bodyOwn: {
    color: colors.paper,
  },
  metaOther: {
    color: colors.faint,
  },
  metaOwn: {
    color: colors.panel,
  },
  row: {
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.xs,
    width: "100%",
  },
  rowOther: {
    alignItems: "flex-start",
  },
  rowOwn: {
    alignItems: "flex-end",
  },
  surface: {
    gap: spacing.sm,
    maxWidth: "82%",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  surfaceOther: {
    backgroundColor: colors.paper,
    borderBottomLeftRadius: 6,
    borderColor: colors.border,
    borderRadius: radii.card,
    borderWidth: 1,
  },
  surfaceOwn: {
    backgroundColor: colors.foreground,
    borderBottomRightRadius: 6,
    borderColor: colors.foreground,
    borderRadius: radii.card,
    borderWidth: 1,
  },
  time: {
    flexShrink: 0,
    ...typography.monoMeta,
  },
});

export default SessionMessageRow;
