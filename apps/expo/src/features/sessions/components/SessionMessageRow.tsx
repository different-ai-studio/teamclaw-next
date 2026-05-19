import { StyleSheet, Text, View } from "react-native";

import { colors, hai, radii, spacing, typography } from "../../../ui/theme";
import type { SessionMessage } from "../session-types";

const HIDDEN_MESSAGE_KINDS = new Set(["permission_request"]);

const AGENT_NOTE_KINDS = new Set([
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

export function isHiddenMessageKind(kind: string): boolean {
  return HIDDEN_MESSAGE_KINDS.has(kind.trim().toLowerCase());
}

export function isAgentNoteKind(kind: string): boolean {
  return AGENT_NOTE_KINDS.has(kind.trim().toLowerCase());
}

/**
 * Eyebrow + tone palette for the three "agent note" message kinds. Mirrors
 * the iOS `StreamingDetailView` styling: tool calls/results use Pebble +
 * Basalt mono labels, agent_thinking is a quiet slate italic. Sage and
 * cinnabar are reserved for the chip bar.
 */
function agentNoteStyle(kind: string): { eyebrow: string; tint: string } {
  const lower = kind.trim().toLowerCase();
  if (lower === "agent_tool_call") {
    return { eyebrow: "TOOL CALL", tint: hai.basalt };
  }
  if (lower === "agent_tool_result") {
    return { eyebrow: "TOOL RESULT", tint: hai.basalt };
  }
  return { eyebrow: "THINKING", tint: hai.slate };
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
  const kindKey = message.kind.trim().toLowerCase();
  if (isHiddenMessageKind(kindKey)) return null;

  const timestamp = formatTimestamp(message.createdAt);

  if (isAgentNoteKind(kindKey)) {
    const note = agentNoteStyle(kindKey);
    return (
      <View style={[styles.row, styles.rowOther]}>
        <View style={[styles.surface, styles.surfaceNote]}>
          <Text style={[styles.noteEyebrow, { color: note.tint }]}>{note.eyebrow}</Text>
          <Text numberOfLines={6} style={styles.noteBody}>
            {normalizeBody(message)}
          </Text>
          {timestamp ? <Text style={styles.timeOther}>{timestamp}</Text> : null}
        </View>
      </View>
    );
  }

  const body = normalizeBody(message);
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
  noteBody: {
    color: colors.basalt,
    ...typography.monoMeta,
  },
  noteEyebrow: {
    ...typography.eyebrow,
    fontWeight: "700",
  },
  surfaceNote: {
    backgroundColor: hai.pebble,
    borderRadius: radii.card,
    gap: 4,
    maxWidth: "92%",
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
