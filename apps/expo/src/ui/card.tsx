import type { ComponentProps } from "react";
import { StyleSheet, View } from "react-native";

import { colors, radii, shadows, spacing } from "./theme";

type ViewProps = ComponentProps<typeof View>;

export type AppCardProps = ViewProps & {
  compact?: boolean;
  elevated?: boolean;
};

export function AppCard({
  compact = false,
  elevated = false,
  style,
  ...viewProps
}: AppCardProps) {
  return (
    <View
      style={[
        styles.card,
        compact ? styles.compact : styles.regular,
        elevated ? styles.elevated : null,
        style,
      ]}
      {...viewProps}
    />
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.paper,
    borderColor: colors.border,
    borderRadius: radii.card,
    borderWidth: 1,
  },
  compact: {
    borderRadius: radii.cardCompact,
    padding: spacing.md,
  },
  elevated: {
    ...shadows.card,
  },
  regular: {
    padding: spacing.lg,
  },
});

export default AppCard;
