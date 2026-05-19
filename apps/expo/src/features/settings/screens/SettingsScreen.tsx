import { Ionicons } from "@expo/vector-icons";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Hairline } from "../../../ui/atoms/Hairline";
import { SectionEyebrow } from "../../../ui/atoms/SectionEyebrow";
import { colors, hai, radii, spacing, typography } from "../../../ui/theme";

export type SettingsTeam = {
  name: string;
  role: string | null;
};

export type SettingsScreenProps = {
  appVersion: string;
  buildNumber: string;
  displayName: string;
  isSigningOut?: boolean;
  onClose: () => void;
  onSignOut?: () => void;
  team: SettingsTeam | null;
  userEmail: string | null;
};

function avatarInitials(name: string): string {
  const parts = name
    .split(/[\s·]+/)
    .filter(Boolean)
    .slice(0, 2);
  if (parts.length === 0) return name.slice(0, 1).toUpperCase();
  return parts.map((p) => p.charAt(0).toUpperCase()).join("");
}

export function SettingsScreen({
  appVersion,
  buildNumber,
  displayName,
  isSigningOut = false,
  onClose,
  onSignOut,
  team,
  userEmail,
}: SettingsScreenProps) {
  return (
    <View style={styles.screen}>
      <View style={styles.headerBar}>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>Settings</Text>
        <Pressable hitSlop={8} onPress={onClose} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </View>
      <Hairline />

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.identityCard}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{avatarInitials(displayName)}</Text>
          </View>
          <View style={styles.identityBody}>
            <Text numberOfLines={1} style={styles.identityName}>
              {displayName}
            </Text>
            {userEmail ? (
              <Text numberOfLines={1} style={styles.identityEmail}>
                {userEmail}
              </Text>
            ) : null}
          </View>
        </View>

        {team ? (
          <View style={styles.section}>
            <SectionEyebrow label="TEAM" style={styles.sectionEyebrow} />
            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Workspace</Text>
                <Text style={styles.rowValue}>{team.name}</Text>
              </View>
              <Hairline />
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Role</Text>
                <Text style={styles.rowValue}>{team.role ?? "member"}</Text>
              </View>
            </View>
          </View>
        ) : null}

        <View style={styles.section}>
          <SectionEyebrow label="ABOUT" style={styles.sectionEyebrow} />
          <View style={styles.card}>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>App version</Text>
              <Text style={styles.rowValueMono}>{appVersion}</Text>
            </View>
            <Hairline />
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Build</Text>
              <Text style={styles.rowValueMono}>{buildNumber}</Text>
            </View>
          </View>
        </View>

        {onSignOut ? (
          <Pressable
            accessibilityRole="button"
            disabled={isSigningOut}
            onPress={onSignOut}
            style={({ pressed }) => [
              styles.signOutButton,
              isSigningOut ? styles.signOutButtonBusy : null,
              pressed && !isSigningOut ? styles.signOutButtonPressed : null,
            ]}
          >
            <Text style={styles.signOutText}>
              {isSigningOut ? "Signing out…" : "Sign out"}
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: {
    alignItems: "center",
    backgroundColor: hai.cinnabar,
    borderRadius: 28,
    height: 56,
    justifyContent: "center",
    width: 56,
  },
  avatarText: {
    color: hai.paper,
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
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
  identityBody: {
    flex: 1,
    gap: 2,
  },
  identityCard: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.md,
    padding: spacing.lg,
  },
  identityEmail: {
    color: colors.slate,
    ...typography.monoMeta,
  },
  identityName: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  rowLabel: {
    color: colors.basalt,
    ...typography.body,
  },
  rowValue: {
    color: colors.onyx,
    ...typography.body,
  },
  rowValueMono: {
    color: colors.onyx,
    ...typography.monoMeta,
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
  signOutButton: {
    alignItems: "center",
    backgroundColor: "rgba(184,75,54,0.10)",
    borderRadius: radii.button,
    paddingVertical: 14,
  },
  signOutButtonBusy: {
    opacity: 0.5,
  },
  signOutButtonPressed: {
    opacity: 0.7,
  },
  signOutText: {
    color: colors.cinnabar,
    ...typography.cardTitle,
  },
});

export default SettingsScreen;
