import { Stack } from "expo-router";

import { colors } from "../../../../src/ui/theme";

export default function SessionsStackLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.mist },
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="[sessionId]" />
      <Stack.Screen
        name="new"
        options={{
          presentation: "modal",
          animation: "slide_from_bottom",
        }}
      />
    </Stack>
  );
}
