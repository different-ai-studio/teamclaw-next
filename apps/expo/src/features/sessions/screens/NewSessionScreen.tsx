import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { Hairline } from "../../../ui/atoms/Hairline";
import { SectionEyebrow } from "../../../ui/atoms/SectionEyebrow";
import { colors, radii, spacing, typography } from "../../../ui/theme";

export type NewSessionScreenProps = {
  onClose: () => void;
  onCreate: (payload: { firstMessage: string }) => Promise<void> | void;
  isBusy?: boolean;
  errorMessage?: string | null;
};

export function NewSessionScreen({
  onClose,
  onCreate,
  isBusy = false,
  errorMessage = null,
}: NewSessionScreenProps) {
  const [firstMessage, setFirstMessage] = useState("");
  const canSubmit = firstMessage.trim().length > 0 && !isBusy;

  const handleStart = () => {
    if (!canSubmit) return;
    void onCreate({ firstMessage: firstMessage.trim() });
  };

  return (
    <View style={styles.screen}>
      <View style={styles.headerBar}>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>New Session</Text>
        <Pressable hitSlop={8} onPress={onClose} style={styles.headerSlot}>
          <Ionicons name="close" size={26} color={colors.onyx} />
        </Pressable>
      </View>
      <Hairline />

      <KeyboardAvoidingView
        behavior={Platform.select({ ios: "padding", default: undefined })}
        style={styles.body}
      >
        <ScrollView
          contentContainerStyle={styles.bodyContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.section}>
            <SectionEyebrow label="01 · COLLABORATORS" />
            <View style={styles.paperCard}>
              <Text style={styles.cardTitle}>Add agents and humans</Text>
              <Text style={styles.cardBody}>
                Choose who the session is for. Coming in the next sub-spec — for
                now, the team's first available agent is auto-selected.
              </Text>
            </View>
          </View>

          <View style={styles.section}>
            <SectionEyebrow label="02 · FIRST MESSAGE" />
            <View style={styles.paperCard}>
              <TextInput
                editable={!isBusy}
                multiline
                onChangeText={setFirstMessage}
                placeholder="What do you want to ask the team?"
                placeholderTextColor={colors.slate}
                selectionColor={colors.cinnabar}
                style={styles.input}
                value={firstMessage}
              />
            </View>
          </View>
        </ScrollView>

        {errorMessage ? (
          <Text style={styles.errorText}>{errorMessage}</Text>
        ) : null}

        <View style={styles.actionsBar}>
          <Pressable
            disabled={!canSubmit}
            onPress={handleStart}
            style={({ pressed }) => [
              styles.cta,
              !canSubmit ? styles.ctaDisabled : null,
              pressed && canSubmit ? styles.ctaPressed : null,
            ]}
          >
            <Text style={styles.ctaText}>
              {isBusy ? "Starting…" : "Start session"}
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  actionsBar: {
    padding: spacing.lg,
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    gap: spacing.xl,
    padding: spacing.lg,
  },
  cardBody: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  cardTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
  cta: {
    alignItems: "center",
    backgroundColor: colors.cinnabar,
    borderRadius: radii.button,
    justifyContent: "center",
    paddingVertical: 14,
  },
  ctaDisabled: {
    opacity: 0.35,
  },
  ctaPressed: {
    opacity: 0.9,
  },
  ctaText: {
    color: colors.paper,
    ...typography.cardTitle,
  },
  errorText: {
    color: colors.cinnabarDeep,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
    ...typography.caption,
  },
  headerBar: {
    alignItems: "center",
    backgroundColor: colors.mist,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 48,
    paddingHorizontal: spacing.xs,
  },
  headerSlot: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 40,
    minWidth: 40,
  },
  headerTitle: {
    color: colors.onyx,
    ...typography.sectionTitle,
  },
  input: {
    color: colors.onyx,
    minHeight: 96,
    padding: 0,
    textAlignVertical: "top",
    ...typography.body,
  },
  paperCard: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    padding: spacing.md,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  section: {
    gap: spacing.sm,
  },
});
