import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { Alert, Image, Pressable, StyleSheet, Text, View } from "react-native";
import Markdown from "react-native-markdown-display";

import { colors, hai, radii, spacing, typography } from "../../../ui/theme";
import type { MessageAttachment, SessionMessage } from "../session-types";
import { AudioPlayerChip } from "./AudioPlayerChip";
import { ImageLightbox } from "./ImageLightbox";

const HIDDEN_MESSAGE_KINDS = new Set(["permission_request"]);

const AGENT_NOTE_KINDS = new Set([
  "agent_thinking",
  "agent_tool_call",
  "agent_tool_result",
]);

export type SessionMessageRowProps = {
  message: SessionMessage;
  isOwnMessage?: boolean;
  onDelete?: (messageId: string) => void;
  onEdit?: (message: SessionMessage) => void;
  onJumpToReply?: (messageId: string) => void;
  onReply?: (message: SessionMessage) => void;
  replyToMessage?: SessionMessage | null;
  senderName?: string;
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

export function SessionMessageRow({
  message,
  isOwnMessage = false,
  onDelete,
  onEdit,
  onJumpToReply,
  onReply,
  replyToMessage,
  senderName,
}: SessionMessageRowProps) {
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const kindKey = message.kind.trim().toLowerCase();
  if (isHiddenMessageKind(kindKey)) return null;

  const timestamp = formatTimestamp(message.createdAt);

  const handleLongPress = () => {
    const options: { text: string; style?: "default" | "cancel" | "destructive"; onPress?: () => void }[] = [
      {
        text: "Copy",
        onPress: () => {
          void Clipboard.setStringAsync(message.content);
        },
      },
    ];
    if (onReply) {
      options.push({
        text: "Reply",
        onPress: () => onReply(message),
      });
    }
    if (isOwnMessage && onEdit) {
      options.push({
        text: "Edit",
        onPress: () => onEdit(message),
      });
    }
    if (isOwnMessage && onDelete) {
      options.push({
        text: "Delete",
        style: "destructive",
        onPress: () => onDelete(message.messageId),
      });
    }
    options.push({ text: "Cancel", style: "cancel" });
    Alert.alert("Message", message.content.slice(0, 80), options);
  };

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
      <Pressable
        accessibilityHint="Long-press to copy or delete"
        delayLongPress={350}
        onLongPress={handleLongPress}
        style={({ pressed }) => [
          styles.surface,
          isOwnMessage ? styles.surfaceOwn : styles.surfaceOther,
          pressed ? styles.surfacePressed : null,
        ]}
      >
        {!isOwnMessage && senderName ? (
          <Text numberOfLines={1} style={styles.senderName}>
            {senderName}
          </Text>
        ) : null}

        {replyToMessage ? (
          <Pressable
            accessibilityRole={onJumpToReply ? "button" : undefined}
            onPress={
              onJumpToReply
                ? () => onJumpToReply(replyToMessage.messageId)
                : undefined
            }
            style={({ pressed }) => [
              styles.replyContext,
              isOwnMessage ? styles.replyContextOwn : styles.replyContextOther,
              pressed && onJumpToReply ? styles.surfacePressed : null,
            ]}
          >
            <View
              style={[
                styles.replyAccent,
                isOwnMessage ? styles.replyAccentOwn : styles.replyAccentOther,
              ]}
            />
            <Text
              numberOfLines={2}
              style={[
                styles.replyBody,
                isOwnMessage ? styles.replyBodyOwn : styles.replyBodyOther,
              ]}
            >
              {replyToMessage.content || "(empty message)"}
            </Text>
          </Pressable>
        ) : null}

        {attachments.length > 0 ? (
          <View style={styles.attachmentList}>
            {attachments.map((attachment, index) => (
              <AttachmentChip
                attachment={attachment}
                isOwn={isOwnMessage}
                key={`${attachment.url}:${index}`}
                onOpenImage={(url) => setLightboxUrl(url)}
              />
            ))}
          </View>
        ) : null}
        <ImageLightbox onClose={() => setLightboxUrl(null)} url={lightboxUrl} />

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
      </Pressable>
    </View>
  );
}

function AttachmentChip({
  attachment,
  isOwn,
  onOpenImage,
}: {
  attachment: MessageAttachment;
  isOwn: boolean;
  onOpenImage?: (url: string) => void;
}) {
  const mime = attachment.mime ?? "";
  if (mime.startsWith("image/")) {
    return (
      <Pressable
        accessibilityRole="image"
        onPress={onOpenImage ? () => onOpenImage(attachment.url) : undefined}
      >
        <Image
          resizeMode="cover"
          source={{ uri: attachment.url }}
          style={styles.attachmentImage}
        />
      </Pressable>
    );
  }
  if (mime.startsWith("audio/")) {
    return <AudioPlayerChip isOwn={isOwn} url={attachment.url} />;
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
  replyAccent: {
    borderRadius: 2,
    width: 3,
  },
  replyAccentOther: {
    backgroundColor: hai.cinnabar,
  },
  replyAccentOwn: {
    backgroundColor: hai.paper,
  },
  replyBody: {
    flex: 1,
    ...typography.caption,
  },
  replyBodyOther: {
    color: colors.basalt,
  },
  replyBodyOwn: {
    color: "rgba(248,246,241,0.85)",
  },
  replyContext: {
    alignSelf: "stretch",
    borderRadius: 8,
    flexDirection: "row",
    gap: 8,
    marginBottom: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  replyContextOther: {
    backgroundColor: hai.pebble,
  },
  replyContextOwn: {
    backgroundColor: "rgba(248,246,241,0.12)",
  },
  senderName: {
    color: colors.basalt,
    marginBottom: 2,
    ...typography.caption,
    fontWeight: "700",
  },
  surfacePressed: {
    opacity: 0.88,
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
