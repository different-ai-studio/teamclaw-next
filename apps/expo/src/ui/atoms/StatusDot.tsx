import { useEffect, useRef } from "react";
import { Animated, StyleSheet, View, type ViewStyle } from "react-native";

import { colors, dotSize } from "../theme";

export type StatusDotKind = "active" | "idle" | "error" | "muted";

export type StatusDotProps = {
  kind?: StatusDotKind;
  size?: number;
  style?: ViewStyle;
};

const KIND_COLOR: Record<StatusDotKind, string> = {
  active: colors.sage,
  idle: colors.slate,
  error: colors.cinnabarDeep,
  muted: colors.slate,
};

/**
 * 8px semantic status indicator. The `active` variant breathes (1.4s
 * ease-in-out, opacity 1 → 0.45) to mirror the iOS @keyframes
 * amuxBreathe rule.
 */
export function StatusDot({ kind = "idle", size = dotSize.status, style }: StatusDotProps) {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (kind !== "active") {
      opacity.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.45,
          duration: 700,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 700,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [kind, opacity]);

  return (
    <Animated.View
      style={[
        styles.dot,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: KIND_COLOR[kind] },
        kind === "active" ? { opacity } : null,
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  dot: {},
});
