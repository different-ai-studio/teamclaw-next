import { Ionicons } from "@expo/vector-icons";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { Hairline } from "../../../ui/atoms/Hairline";
import { SectionEyebrow } from "../../../ui/atoms/SectionEyebrow";
import { colors, hai, radii, spacing, typography } from "../../../ui/theme";
import type { Idea, IdeaStatus } from "../idea-types";

export type IdeaDetailScreenProps = {
  creatorName: string | null;
  idea: Idea | null;
  isLoading: boolean;
  onClose: () => void;
};

type StatusPill = {
  label: string;
  foreground: string;
  background: string;
};

function statusPill(status: IdeaStatus): StatusPill {
  switch (status) {
    case "done":
      return {
        label: "DONE",
        foreground: hai.sage,
        background: "rgba(107,142,90,0.12)",
      };
    case "in_progress":
      return {
        label: "IN PROGRESS",
        foreground: hai.basalt,
        background: hai.pebble,
      };
    case "open":
    default:
      return {
        label: "OPEN",
        foreground: hai.cinnabar,
        background: "rgba(184,75,54,0.10)",
      };
  }
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(new Date(value));
  } catch {
    return "—";
  }
}

export function IdeaDetailScreen({
  creatorName,
  idea,
  isLoading,
  onClose,
}: IdeaDetailScreenProps) {
  return (
    <View style={styles.screen}>
      <View style={styles.headerBar}>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>Idea</Text>
        <Pressable hitSlop={8} onPress={onClose} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </View>
      <Hairline />

      <ScrollView contentContainerStyle={styles.content}>
        {isLoading && idea === null ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.slate} />
            <Text style={styles.loadingText}>Loading idea…</Text>
          </View>
        ) : idea === null ? (
          <View style={styles.stateBlock}>
            <Text style={styles.stateTitle}>Idea not found</Text>
            <Text style={styles.stateBody}>
              The idea may have been archived or removed.
            </Text>
          </View>
        ) : (
          <>
            <Hero idea={idea} />

            {idea.description ? (
              <View style={styles.section}>
                <SectionEyebrow label="DESCRIPTION" style={styles.sectionEyebrow} />
                <View style={styles.card}>
                  <Text style={styles.descriptionText}>{idea.description}</Text>
                </View>
              </View>
            ) : null}

            <View style={styles.section}>
              <SectionEyebrow label="META" style={styles.sectionEyebrow} />
              <View style={styles.card}>
                <DetailRow label="Workspace" value={idea.workspaceName ?? "—"} />
                <Hairline />
                <DetailRow label="Created by" value={creatorName ?? "—"} />
                <Hairline />
                <DetailRow label="Created" value={formatTimestamp(idea.createdAt)} />
                <Hairline />
                <DetailRow label="Updated" value={formatTimestamp(idea.updatedAt)} />
              </View>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function Hero({ idea }: { idea: Idea }) {
  const pill = statusPill(idea.status);
  const isDone = idea.status === "done";
  return (
    <View style={styles.hero}>
      <View style={[styles.pill, { backgroundColor: pill.background }]}>
        <Text style={[styles.pillText, { color: pill.foreground }]}>{pill.label}</Text>
      </View>
      <Text style={[styles.heroTitle, isDone ? styles.heroTitleDone : null]}>
        {idea.title}
      </Text>
    </View>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text numberOfLines={1} style={styles.detailValue}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  content: {
    gap: spacing.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  descriptionText: {
    color: colors.onyx,
    padding: spacing.md,
    ...typography.body,
  },
  detailLabel: {
    color: colors.basalt,
    ...typography.body,
  },
  detailRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  detailValue: {
    color: colors.onyx,
    flexShrink: 1,
    ...typography.body,
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
  hero: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
    padding: spacing.lg,
  },
  heroTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
    fontSize: 22,
    lineHeight: 28,
  },
  heroTitleDone: {
    color: colors.slate,
    textDecorationLine: "line-through",
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
  pill: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: radii.chip,
    height: 20,
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  pillText: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  section: {
    gap: spacing.sm,
  },
  sectionEyebrow: {
    paddingHorizontal: spacing.xs,
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
});

export default IdeaDetailScreen;
