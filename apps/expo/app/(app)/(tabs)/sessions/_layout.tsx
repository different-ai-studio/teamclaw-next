import { Stack } from "expo-router";

import { colors } from "../../../../src/ui/theme";

export default function SessionsStackLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.mist },
      }}
    />
  );
}
