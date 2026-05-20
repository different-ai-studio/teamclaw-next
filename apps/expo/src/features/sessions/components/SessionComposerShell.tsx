import { Ionicons } from "@expo/vector-icons";
import type { ComponentProps } from "react";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { colors, hai, radii, shadows, spacing, typography } from "../../../ui/theme";
import {
  buildComposerPresentation,
} from "./session-composer-copy";
import { useVoiceRecorder } from "./voice-recorder";
import type { SessionDetailConnectionState } from "../session-detail-controller";

type SessionComposerShellProps = {
  composerText: string;
  connectionState: SessionDetailConnectionState;
  isSending: boolean;
  onAttach?: () => void;
  onChangeText: (value: string) => void;
  onSend: () => void;
  sendErrorMessage: string | null;
};

type IconName = ComponentProps<typeof Ionicons>["name"];

function IconChip({ name, onPress }: { name: IconName; onPress?: () => void }) {
  if (onPress) {
    return (
      <Pressable hitSlop={6} onPress={onPress} style={styles.iconChip}>
        <Ionicons name={name} size={14} color={colors.slate} />
      </Pressable>
    );
  }
  return (
    <View style={styles.iconChip}>
      <Ionicons name={name} size={14} color={colors.slate} />
    </View>
  );
}

export function SessionComposerShell({
  composerText,
  connectionState,
  isSending,
  onAttach,
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
  const recorder = useVoiceRecorder();
  const [recordError, setRecordError] = useState<string | null>(null);

  const handleMicToggle = async () => {
    setRecordError(null);
    try {
      if (recorder.isRecording) {
        const uri = await recorder.stop();
        if (uri) {
          onChangeText(`${composerText}${composerText.length > 0 ? " " : ""}🎙️ ${uri}`);
        }
      } else {
        await recorder.start();
      }
    } catch (err) {
      setRecordError(err instanceof Error ? err.message : "Couldn't access microphone.");
    }
  };

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
            <IconChip name="add" onPress={onAttach} />
            <IconChip name="at" />
            <IconChip name="sparkles-outline" />
          </View>

          <View style={styles.footerRight}>
            {composerText.trim().length === 0 ? (
              <Pressable
                accessibilityLabel={recorder.isRecording ? "Stop recording" : "Voice memo"}
                accessibilityRole="button"
                hitSlop={6}
                onPress={handleMicToggle}
                style={[styles.micButton, recorder.isRecording ? styles.micButtonRecording : null]}
              >
                <Ionicons
                  color={recorder.isRecording ? hai.paper : colors.slate}
                  name={recorder.isRecording ? "stop" : "mic-outline"}
                  size={18}
                />
              </Pressable>
            ) : (
              <Text style={styles.keyboardHint}>⌘↵</Text>
            )}
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

      {recordError ? (
        <Text style={styles.helperTextError}>{recordError}</Text>
      ) : recorder.isRecording ? (
        <Text style={styles.helperText}>
          Recording · {Math.floor(recorder.durationMs / 1000)}s — tap the stop
          button to insert.
        </Text>
      ) : presentation.helperText ? (
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
  keyboardHint: {
    color: colors.faint,
    ...typography.monoMeta,
  },
  helperTextError: {
    color: hai.cinnabarDeep,
    ...typography.caption,
  },
  micButton: {
    alignItems: "center",
    borderRadius: 999,
    height: 28,
    justifyContent: "center",
    width: 28,
  },
  micButtonRecording: {
    backgroundColor: hai.cinnabar,
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
