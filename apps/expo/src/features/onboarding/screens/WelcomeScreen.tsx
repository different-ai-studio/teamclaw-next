import { StyleSheet, Text, View } from "react-native";

import { PrimaryButton } from "../../../ui/button";
import { AppCard } from "../../../ui/card";
import { colors, radii, spacing, typography } from "../../../ui/theme";

type WelcomeScreenProps = {
  onGetStarted: () => void;
};

export function WelcomeScreen({ onGetStarted }: WelcomeScreenProps) {
  return (
    <View style={styles.screen}>
      <View style={styles.content}>
        <View style={styles.brandBlock}>
          <Text style={styles.kicker}>TEAMCLAW</Text>
          <Text style={styles.title}>A calm place to start the work together.</Text>
          <Text style={styles.body}>
            TeamClaw keeps your team, actors, and next actions in one steady flow. Start
            with a quick sign-in, then set up the first team space.
          </Text>
        </View>

        <AppCard elevated style={styles.card}>
          <Text style={styles.cardTitle}>Welcome aboard</Text>
          <Text style={styles.cardBody}>
            Use email magic code or continue as a guest first. You can connect a full account
            after you get inside.
          </Text>
          <PrimaryButton label="Get Started" onPress={onGetStarted} />
        </AppCard>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    color: colors.ink2,
    ...typography.body,
  },
  brandBlock: {
    gap: spacing.sm,
  },
  card: {
    gap: spacing.md,
  },
  cardBody: {
    color: colors.ink2,
    ...typography.secondaryBody,
  },
  cardTitle: {
    color: colors.foreground,
    ...typography.cardTitle,
  },
  content: {
    gap: spacing.xl,
    maxWidth: 460,
    width: "100%",
  },
  kicker: {
    alignSelf: "flex-start",
    backgroundColor: colors.panel,
    borderRadius: radii.pill,
    color: colors.ink2,
    paddingHorizontal: 10,
    paddingVertical: 5,
    ...typography.pill,
  },
  screen: {
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: "center",
    padding: spacing.xxl,
  },
  title: {
    color: colors.foreground,
    fontSize: 28,
    fontWeight: "700",
    lineHeight: 36,
  },
});
