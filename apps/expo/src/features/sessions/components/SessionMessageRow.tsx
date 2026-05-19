import { StyleSheet, Text, View } from "react-native";

import { colors, radii, spacing, typography } from "../../../ui/theme";
import type { SessionMessage } from "../session-types";

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
    return "(empty message)";
  }
  return body;
}

export function isNonDisplayableKind(kind: string): boolean {
  return NON_DISPLAYABLE_MESSAGE_KINDS.has(kind.trim().toLowerCase());
}

export function formatTimestamp(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function SessionMessageRow({ message, isOwnMessage = false }: SessionMessageRowProps) {
  const body = isNonDisplayableKind(message.kind)
    ? "(unsupported event)"
    : normalizeBody(message);
  const timestamp = formatTimestamp(message.createdAt);

  return (
    <View style={[styles.row, isOwnMessage ? styles.rowOwn : styles.rowOther]}>
      <View
        style={[
          styles.surface,
          isOwnMessage ? styles.surfaceOwn : styles.surfaceOther,
        ]}
      >
        <Text style={[styles.body, isOwnMessage ? styles.bodyOwn : styles.bodyOther]}>
          {body}
        </Text>
        {timestamp ? (
          <Text style={[styles.time, isOwnMessage ? styles.timeOwn : styles.timeOther]}>
            {timestamp}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    ...typography.body,
  },
  bodyOther: {
    color: colors.onyx,
  },
  bodyOwn: {
    color: colors.paper,
  },
  row: {
    paddingHorizontal: spacing.lg,
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
    gap: 4,
    maxWidth: "82%",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  surfaceOther: {
    backgroundColor: colors.paper,
    borderBottomLeftRadius: radii.hairline,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
  },
  surfaceOwn: {
    backgroundColor: colors.onyx,
    borderBottomRightRadius: radii.hairline,
    borderRadius: radii.card,
  },
  time: {
    flexShrink: 0,
    ...typography.monoMeta,
    fontSize: 10,
  },
  timeOther: {
    color: colors.slate,
  },
  timeOwn: {
    color: "rgba(248,246,241,0.6)",
  },
});

export default SessionMessageRow;
