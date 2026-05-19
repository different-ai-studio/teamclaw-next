import { Stack } from "expo-router";
import { StyleSheet, View } from "react-native";

import { colors } from "../../src/ui/theme";

export default function AppLayout() {
  return (
    <View style={styles.layout}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="home" />
        <Stack.Screen
          name="new-session"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
        <Stack.Screen
          name="settings"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
        <Stack.Screen
          name="session-members"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
        <Stack.Screen
          name="actor-detail"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
        <Stack.Screen
          name="idea-detail"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
        <Stack.Screen
          name="attach"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
        <Stack.Screen
          name="workspaces"
          options={{
            presentation: "modal",
            animation: "slide_from_bottom",
            contentStyle: { backgroundColor: colors.mist },
          }}
        />
      </Stack>
    </View>
  );
}

const styles = StyleSheet.create({
  layout: {
    backgroundColor: colors.background,
    flex: 1,
  },
});
