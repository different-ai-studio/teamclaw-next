import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { StyleSheet } from "react-native";

import { colors, typography } from "../../../src/ui/theme";

type TabIconProps = {
  color: string;
  focused: boolean;
  size: number;
};

type IconName = keyof typeof Ionicons.glyphMap;

function makeIcon(activeName: IconName, idleName: IconName) {
  return function TabIcon({ color, focused, size }: TabIconProps) {
    return (
      <Ionicons name={focused ? activeName : idleName} size={size} color={color} />
    );
  };
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.cinnabar,
        tabBarInactiveTintColor: colors.slate,
        tabBarLabelStyle: styles.label,
        tabBarStyle: styles.bar,
        sceneStyle: styles.scene,
      }}
    >
      <Tabs.Screen
        name="sessions"
        options={{
          title: "Sessions",
          tabBarIcon: makeIcon("chatbubbles", "chatbubbles-outline"),
        }}
      />
      <Tabs.Screen
        name="ideas"
        options={{
          title: "Ideas",
          tabBarIcon: makeIcon("bulb", "bulb-outline"),
        }}
      />
      <Tabs.Screen
        name="actors"
        options={{
          title: "Actors",
          tabBarIcon: makeIcon("people", "people-outline"),
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: "Search",
          tabBarIcon: makeIcon("search", "search-outline"),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: colors.paper,
    borderTopColor: colors.hairline,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  label: {
    ...typography.monoMeta,
    fontSize: 10,
    letterSpacing: 0.4,
    marginTop: -2,
  },
  scene: {
    backgroundColor: colors.mist,
  },
});
