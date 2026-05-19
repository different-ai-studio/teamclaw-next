import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { colors, radii, shadows, spacing, typography } from "../../../ui/theme";
import {
  buildComposerPresentation,
} from "./session-composer-copy";
import type { SessionDetailConnectionState } from "../session-detail-controller";

type SessionComposerShellProps = {
  composerText: string;
  connectionState: SessionDetailConnectionState;
  isSending: boolean;
  onChangeText: (value: string) => void;
  onSend: () => void;
  sendErrorMessage: string | null;
};

function IconChip({ label }: { label: string }) {
  return (
    <View style={styles.iconChip}>
      <Text style={styles.iconChipText}>{label}</Text>
    </View>
  );
}

export function SessionComposerShell({
  composerText,
  connectionState,
  isSending,
  onChangeText,
  onSend,
  sendErrorMessage,
}: SessionComposerShellProps) {
  const presentation = buildComposerPresentation({
    composerText,
    connectionState,
    isSending,
    sendErrorMessage,
  });

  return (
    <View style={styles.wrapper}>
      <View style={styles.composerCard}>
        <View style={styles.editorSurface}>
          <TextInput
            editable={!isSending && connectionState !== "disconnected"}
            multiline
            onChangeText={onChangeText}
            placeholder={presentation.placeholder}
            placeholderTextColor={colors.faint}
            selectionColor={colors.coral}
            style={styles.input}
            value={composerText}
          />
        </View>

        <View style={styles.footer}>
          <View style={styles.footerLeft}>
            <View style={styles.agentPill}>
              <View style={styles.agentDot} />
              <Text style={styles.agentPillText}>TeamClaw AI</Text>
              <Text style={styles.agentChevron}>▾</Text>
            </View>
            <IconChip label="＋" />
            <IconChip label="@" />
            <IconChip label="✦" />
          </View>

          <View style={styles.footerRight}>
            <Text style={styles.keyboardHint}>⌘↵</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: presentation.isDisabled }}
              disabled={presentation.isDisabled}
              onPress={onSend}
              style={({ pressed }) => [
                styles.sendButton,
                presentation.isDisabled && styles.sendButtonDisabled,
                pressed && !presentation.isDisabled && styles.sendButtonPressed,
              ]}
            >
              <Text style={styles.sendButtonText}>{presentation.sendLabel}</Text>
            </Pressable>
          </View>
        </View>
      </View>

      {presentation.helperText ? (
        <Text style={styles.helperText}>{presentation.helperText}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  agentChevron: {
    color: colors.faint,
    ...typography.caption,
  },
  agentDot: {
    backgroundColor: colors.coral,
    borderRadius: radii.chip,
    height: 8,
    width: 8,
  },
  agentPill: {
    alignItems: "center",
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderRadius: radii.pill,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  agentPillText: {
    color: colors.ink2,
    ...typography.caption,
  },
  composerCard: {
    backgroundColor: colors.paper,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
    ...shadows.composer,
  },
  editorSurface: {
    minHeight: 92,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  footer: {
    alignItems: "center",
    borderTopColor: colors.borderSoft,
    borderTopWidth: 1,
    flexDirection: "row",
    gap: spacing.md,
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  footerLeft: {
    alignItems: "center",
    flexDirection: "row",
    flexShrink: 1,
    gap: spacing.sm,
  },
  footerRight: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  helperText: {
    color: colors.ink2,
    ...typography.caption,
  },
  input: {
    color: colors.foreground,
    minHeight: 64,
    padding: 0,
    textAlignVertical: "top",
    ...typography.body,
  },
  iconChip: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderColor: colors.border,
    borderRadius: radii.chip,
    borderWidth: 1,
    height: 24,
    justifyContent: "center",
    width: 24,
  },
  iconChipText: {
    color: colors.faint,
    fontSize: 12,
    fontWeight: "600",
    lineHeight: 14,
  },
  keyboardHint: {
    color: colors.faint,
    ...typography.monoMeta,
  },
  placeholder: {
    color: colors.mutedForeground,
    ...typography.body,
  },
  sendButton: {
    alignItems: "center",
    backgroundColor: colors.coral,
    borderRadius: radii.button,
    justifyContent: "center",
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  sendButtonDisabled: {
    opacity: 0.4,
  },
  sendButtonPressed: {
    opacity: 0.88,
  },
  sendButtonText: {
    color: colors.paper,
    ...typography.cardTitle,
  },
  wrapper: {
    gap: spacing.sm,
  },
});

export default SessionComposerShell;
