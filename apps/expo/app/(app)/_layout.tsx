import { Stack } from "expo-router";
import { StyleSheet, View } from "react-native";

import { colors } from "../../src/ui/theme";

export default function AppLayout() {
  return (
    <View style={styles.layout}>
      <Stack screenOptions={{ headerShown: false }} />
    </View>
  );
}

const styles = StyleSheet.create({
  layout: {
    backgroundColor: colors.background,
    flex: 1,
  },
});
