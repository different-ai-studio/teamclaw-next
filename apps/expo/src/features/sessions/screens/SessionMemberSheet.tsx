import { Ionicons } from "@expo/vector-icons";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { ActorRow } from "../../actors/components/ActorRow";
import { isAgentActor, isMemberActor, type Actor } from "../../actors/actor-types";
import { Hairline } from "../../../ui/atoms/Hairline";
import { SectionEyebrow } from "../../../ui/atoms/SectionEyebrow";
import { colors, spacing, typography } from "../../../ui/theme";

export type SessionMemberSheetProps = {
  actors: Actor[];
  currentActorId: string | null;
  isLoading: boolean;
  onAddAgent?: () => void;
  onAddMember?: () => void;
  onClose: () => void;
};

function ToolbarButton({
  accessibilityLabel,
  iconName,
  onPress,
}: {
  accessibilityLabel: string;
  iconName: React.ComponentProps<typeof Ionicons>["name"];
  onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      disabled={!onPress}
      hitSlop={8}
      onPress={onPress}
      style={styles.toolbarButton}
    >
      <Ionicons
        color={onPress ? colors.onyx : colors.slate}
        name={iconName}
        size={22}
      />
    </Pressable>
  );
}

export function SessionMemberSheet({
  actors,
  currentActorId,
  isLoading,
  onAddAgent,
  onAddMember,
  onClose,
}: SessionMemberSheetProps) {
  const humans = actors.filter(isMemberActor);
  const agents = actors.filter(isAgentActor);

  return (
    <View style={styles.screen}>
      <View style={styles.headerBar}>
        <Pressable hitSlop={8} onPress={onClose} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
        <Text style={styles.headerTitle}>Actors</Text>
        <View style={styles.headerActions}>
          <ToolbarButton
            accessibilityLabel="Add member"
            iconName="person-add-outline"
            onPress={onAddMember}
          />
          <ToolbarButton
            accessibilityLabel="Add agent"
            iconName="sparkles-outline"
            onPress={onAddAgent}
          />
        </View>
      </View>
      <Hairline />

      <ScrollView contentContainerStyle={styles.content}>
        {isLoading && actors.length === 0 ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.slate} />
            <Text style={styles.loadingText}>Loading members…</Text>
          </View>
        ) : actors.length === 0 ? (
          <View style={styles.stateBlock}>
            <Text style={styles.stateTitle}>No participants</Text>
            <Text style={styles.stateBody}>
              This session doesn't have any actors yet.
            </Text>
          </View>
        ) : (
          <View style={styles.groups}>
            {humans.length > 0 ? (
              <View style={styles.section}>
                <SectionEyebrow
                  label={`MEMBERS · ${humans.length}`}
                  style={styles.sectionLabel}
                />
                <View>
                  {humans.map((actor, index) => (
                    <View key={actor.actorId}>
                      <ActorRow actor={actor} isMe={actor.actorId === currentActorId} />
                      {index < humans.length - 1 ? (
                        <Hairline style={styles.rowDivider} />
                      ) : null}
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
            {agents.length > 0 ? (
              <View style={styles.section}>
                <SectionEyebrow
                  label={`AGENTS · ${agents.length}`}
                  style={styles.sectionLabel}
                />
                <View>
                  {agents.map((actor, index) => (
                    <View key={actor.actorId}>
                      <ActorRow actor={actor} />
                      {index < agents.length - 1 ? (
                        <Hairline style={styles.rowDivider} />
                      ) : null}
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.md,
    paddingBottom: spacing.xxxl,
  },
  groups: {
    gap: spacing.lg,
  },
  headerActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.xs,
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
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  loadingText: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  rowDivider: {
    marginLeft: 70,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  section: {
    gap: spacing.sm,
  },
  sectionLabel: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  stateBlock: {
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  stateBody: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  stateTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
  toolbarButton: {
    alignItems: "center",
    height: 40,
    justifyContent: "center",
    minWidth: 40,
  },
});

export default SessionMemberSheet;
