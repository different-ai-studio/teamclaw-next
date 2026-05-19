import { Image, StyleSheet, Text, View } from "react-native";
import Markdown from "react-native-markdown-display";

import { colors, hai, radii, spacing, typography } from "../../../ui/theme";
import type { MessageAttachment, SessionMessage } from "../session-types";

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
  const attachments = message.attachments ?? [];
  return (
    <View style={[styles.row, isOwnMessage ? styles.rowOwn : styles.rowOther]}>
      <View
        style={[
          styles.surface,
          isOwnMessage ? styles.surfaceOwn : styles.surfaceOther,
        ]}
      >
        {attachments.length > 0 ? (
          <View style={styles.attachmentList}>
            {attachments.map((attachment, index) => (
              <AttachmentChip
                attachment={attachment}
                isOwn={isOwnMessage}
                key={`${attachment.url}:${index}`}
              />
            ))}
          </View>
        ) : null}

        {body.length > 0 ? (
          <Markdown
            style={isOwnMessage ? ownMarkdown : otherMarkdown}
          >
            {body}
          </Markdown>
        ) : null}

        {timestamp ? (
          <Text style={[styles.time, isOwnMessage ? styles.timeOwn : styles.timeOther]}>
            {timestamp}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function AttachmentChip({
  attachment,
  isOwn,
}: {
  attachment: MessageAttachment;
  isOwn: boolean;
}) {
  const mime = attachment.mime ?? "";
  if (mime.startsWith("image/")) {
    return (
      <Image
        accessibilityRole="image"
        resizeMode="cover"
        source={{ uri: attachment.url }}
        style={styles.attachmentImage}
      />
    );
  }
  const label = attachment.path?.split("/").pop() ?? (mime || "Attachment");
  return (
    <View
      style={[
        styles.attachmentPill,
        isOwn ? styles.attachmentPillOwn : styles.attachmentPillOther,
      ]}
    >
      <Text
        numberOfLines={1}
        style={[styles.attachmentLabel, isOwn ? styles.attachmentLabelOwn : null]}
      >
        {label}
      </Text>
    </View>
  );
}

const ownMarkdown = {
  body: { color: hai.paper, ...typography.body, marginBottom: 0, marginTop: 0 },
  code_inline: {
    backgroundColor: "rgba(248,246,241,0.18)",
    borderRadius: 4,
    color: hai.paper,
    paddingHorizontal: 4,
  },
  code_block: {
    backgroundColor: "rgba(248,246,241,0.18)",
    borderRadius: 6,
    color: hai.paper,
    padding: 8,
  },
  link: { color: hai.paper, textDecorationLine: "underline" as const },
  paragraph: { color: hai.paper, marginBottom: 0, marginTop: 0 },
};

const otherMarkdown = {
  body: { color: hai.onyx, ...typography.body, marginBottom: 0, marginTop: 0 },
  code_inline: {
    backgroundColor: hai.pebble,
    borderRadius: 4,
    color: hai.onyx,
    paddingHorizontal: 4,
  },
  code_block: {
    backgroundColor: hai.pebble,
    borderRadius: 6,
    color: hai.onyx,
    padding: 8,
  },
  link: { color: hai.cinnabar, textDecorationLine: "underline" as const },
  paragraph: { color: hai.onyx, marginBottom: 0, marginTop: 0 },
};

const styles = StyleSheet.create({
  attachmentImage: {
    backgroundColor: hai.pebble,
    borderRadius: 10,
    height: 180,
    width: 220,
  },
  attachmentLabel: {
    color: hai.onyx,
    ...typography.caption,
    fontWeight: "600",
  },
  attachmentLabelOwn: {
    color: hai.paper,
  },
  attachmentList: {
    gap: 6,
  },
  attachmentPill: {
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  attachmentPillOther: {
    backgroundColor: hai.pebble,
  },
  attachmentPillOwn: {
    backgroundColor: "rgba(248,246,241,0.18)",
  },
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
