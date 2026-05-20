import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import {
  ActionSheetIOS,
  Alert,
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
  agents?: ReadonlyArray<{ actorId: string; displayName: string }>;
  errorMessage?: string | null;
  ideas?: ReadonlyArray<{ ideaId: string; displayTitle: string }>;
  isBusy?: boolean;
  onClose: () => void;
  onCreate: (payload: {
    firstMessage: string;
    agentActorId: string | null;
    ideaId: string | null;
  }) => Promise<void> | void;
  selectedAgentActorId?: string | null;
  selectedIdeaId?: string | null;
};

export function NewSessionScreen({
  agents = [],
  errorMessage = null,
  ideas = [],
  isBusy = false,
  onClose,
  onCreate,
  selectedAgentActorId,
  selectedIdeaId = null,
}: NewSessionScreenProps) {
  const [firstMessage, setFirstMessage] = useState("");
  const [pickedAgentId, setPickedAgentId] = useState<string | null>(
    selectedAgentActorId ?? agents[0]?.actorId ?? null,
  );
  const [pickedIdeaId, setPickedIdeaId] = useState<string | null>(selectedIdeaId);
  const canSubmit = firstMessage.trim().length > 0 && !isBusy;

  const handleStart = () => {
    if (!canSubmit) return;
    void onCreate({
      firstMessage: firstMessage.trim(),
      agentActorId: pickedAgentId,
      ideaId: pickedIdeaId,
    });
  };

  const ideaLabel =
    pickedIdeaId === null
      ? "None"
      : ideas.find((i) => i.ideaId === pickedIdeaId)?.displayTitle ?? "—";

  const showIdeaPicker = () => {
    if (ideas.length === 0) return;
    const labels = ["None", ...ideas.map((i) => i.displayTitle), "Cancel"];
    const dispatch = (index: number) => {
      if (index === 0) setPickedIdeaId(null);
      else if (index > 0 && index <= ideas.length) {
        setPickedIdeaId(ideas[index - 1].ideaId);
      }
    };
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: labels, cancelButtonIndex: labels.length - 1 },
        dispatch,
      );
      return;
    }
    Alert.alert(
      "Link to idea",
      undefined,
      labels.map((label, index) => {
        if (index === labels.length - 1) {
          return { text: label, style: "cancel" as const };
        }
        return { text: label, onPress: () => dispatch(index) };
      }),
    );
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
              <Text style={styles.cardTitle}>Pick an agent</Text>
              {agents.length === 0 ? (
                <Text style={styles.cardBody}>
                  No agents on this team yet — invite one from the Actors tab
                  to engage the session.
                </Text>
              ) : (
                <View style={styles.agentRow}>
                  {agents.map((agent) => {
                    const selected = agent.actorId === pickedAgentId;
                    return (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        key={agent.actorId}
                        onPress={() => setPickedAgentId(agent.actorId)}
                        style={[
                          styles.agentChip,
                          selected ? styles.agentChipSelected : null,
                        ]}
                      >
                        <Text
                          style={[
                            styles.agentChipText,
                            selected ? styles.agentChipTextSelected : null,
                          ]}
                        >
                          {agent.displayName}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </View>
          </View>

          {ideas.length > 0 ? (
            <View style={styles.section}>
              <SectionEyebrow label="02 · IDEA" />
              <Pressable
                accessibilityRole="button"
                onPress={showIdeaPicker}
                style={({ pressed }) => [
                  styles.paperCard,
                  styles.ideaRow,
                  pressed ? styles.ideaRowPressed : null,
                ]}
              >
                <Text style={styles.cardTitle}>Link to idea</Text>
                <View style={styles.ideaValue}>
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.cardBody,
                      pickedIdeaId === null ? styles.ideaValueMuted : null,
                    ]}
                  >
                    {ideaLabel}
                  </Text>
                  <Ionicons color={colors.slate} name="chevron-down" size={14} />
                </View>
              </Pressable>
            </View>
          ) : null}

          <View style={styles.section}>
            <SectionEyebrow
              label={ideas.length > 0 ? "03 · FIRST MESSAGE" : "02 · FIRST MESSAGE"}
            />
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
  agentChip: {
    backgroundColor: colors.pebble,
    borderRadius: radii.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  agentChipSelected: {
    backgroundColor: colors.onyx,
  },
  agentChipText: {
    color: colors.basalt,
    ...typography.body,
    fontWeight: "600",
  },
  agentChipTextSelected: {
    color: colors.paper,
  },
  agentRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
    paddingTop: 4,
  },
  ideaRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "space-between",
  },
  ideaRowPressed: {
    opacity: 0.8,
  },
  ideaValue: {
    alignItems: "center",
    flexDirection: "row",
    gap: 4,
    maxWidth: 200,
  },
  ideaValueMuted: {
    color: colors.slate,
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
