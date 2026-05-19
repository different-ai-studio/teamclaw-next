import { Ionicons } from "@expo/vector-icons";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useOnboarding } from "../_layout";
import { createShortcutsApi } from "../../src/features/shortcuts/shortcut-api";
import {
  isLeafShortcut,
  type Shortcut,
} from "../../src/features/shortcuts/shortcut-types";
import { Hairline } from "../../src/ui/atoms/Hairline";
import { SectionEyebrow } from "../../src/ui/atoms/SectionEyebrow";
import { supabase } from "../../src/lib/supabase/client";
import { colors, hai, radii, spacing, typography } from "../../src/ui/theme";

export default function ShortcutsRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const teamId = state.currentTeam?.id ?? "";
  const [shortcuts, setShortcuts] = useState<Shortcut[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!teamId) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    void (async () => {
      try {
        const rows = await createShortcutsApi(supabase).listShortcuts(teamId);
        if (!cancelled) setShortcuts(rows);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load shortcuts.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  const handleOpen = async (shortcut: Shortcut) => {
    if (!shortcut.target) return;
    if (shortcut.nodeType === "session") {
      router.push(`/(app)/sessions/${shortcut.target}`);
      return;
    }
    try {
      const supported = await Linking.canOpenURL(shortcut.target);
      if (supported) {
        await Linking.openURL(shortcut.target);
      }
    } catch {
      // Swallow — the user can see the error toast in a future polish pass.
    }
  };

  const folders = shortcuts.filter((row) => row.nodeType === "folder");
  const leaves = shortcuts.filter(isLeafShortcut);

  return (
    <View style={styles.screen}>
      <View style={styles.headerBar}>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>Shortcuts</Text>
        <Pressable hitSlop={8} onPress={() => router.back()} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </View>
      <Hairline />

      <ScrollView contentContainerStyle={styles.content}>
        {isLoading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.slate} />
            <Text style={styles.body}>Loading shortcuts…</Text>
          </View>
        ) : error ? (
          <View style={styles.stateBlock}>
            <Text style={styles.stateTitle}>Couldn't load shortcuts</Text>
            <Text style={styles.body}>{error}</Text>
          </View>
        ) : shortcuts.length === 0 ? (
          <View style={styles.stateBlock}>
            <Text style={styles.stateTitle}>No shortcuts</Text>
            <Text style={styles.body}>
              Pin a URL, session, or team page to your shortcuts drawer to see it here.
            </Text>
          </View>
        ) : (
          <View style={styles.groups}>
            {folders.length > 0 ? (
              <View style={styles.section}>
                <SectionEyebrow
                  label={`FOLDERS · ${folders.length}`}
                  style={styles.sectionEyebrow}
                />
                <View style={styles.card}>
                  {folders.map((folder, index) => (
                    <View key={folder.id}>
                      <View style={styles.row}>
                        <View style={styles.iconTile}>
                          <Ionicons color={colors.basalt} name="folder-outline" size={18} />
                        </View>
                        <Text style={styles.rowLabel}>{folder.label}</Text>
                      </View>
                      {index < folders.length - 1 ? <Hairline /> : null}
                    </View>
                  ))}
                </View>
              </View>
            ) : null}

            {leaves.length > 0 ? (
              <View style={styles.section}>
                <SectionEyebrow
                  label={`PINNED · ${leaves.length}`}
                  style={styles.sectionEyebrow}
                />
                <View style={styles.card}>
                  {leaves.map((shortcut, index) => (
                    <View key={shortcut.id}>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => handleOpen(shortcut)}
                        style={({ pressed }) => [
                          styles.row,
                          pressed ? styles.rowPressed : null,
                        ]}
                      >
                        <View style={styles.iconTile}>
                          <Ionicons
                            color={colors.cinnabar}
                            name={iconNameForLeaf(shortcut.nodeType)}
                            size={18}
                          />
                        </View>
                        <View style={styles.rowBody}>
                          <Text style={styles.rowLabel}>{shortcut.label}</Text>
                          {shortcut.target ? (
                            <Text numberOfLines={1} style={styles.rowMeta}>
                              {shortcut.target}
                            </Text>
                          ) : null}
                        </View>
                        <Ionicons color={colors.slate} name="open-outline" size={16} />
                      </Pressable>
                      {index < leaves.length - 1 ? <Hairline /> : null}
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
          </View>
        )}

        <View style={styles.section}>
          <SectionEyebrow label="SYSTEM" style={styles.sectionEyebrow} />
          <View style={styles.card}>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push("/(app)/settings")}
              style={({ pressed }) => [
                styles.row,
                pressed ? styles.rowPressed : null,
              ]}
            >
              <View style={styles.iconTile}>
                <Ionicons color={colors.basalt} name="settings-outline" size={18} />
              </View>
              <Text style={styles.rowLabel}>Settings</Text>
              <View style={{ flex: 1 }} />
              <Ionicons color={colors.slate} name="chevron-forward" size={16} />
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

function iconNameForLeaf(nodeType: Shortcut["nodeType"]): React.ComponentProps<typeof Ionicons>["name"] {
  switch (nodeType) {
    case "session":
      return "chatbubbles-outline";
    case "team":
      return "people-outline";
    case "external":
      return "link-outline";
    case "url":
    default:
      return "globe-outline";
  }
}

const styles = StyleSheet.create({
  body: {
    color: colors.basalt,
    ...typography.secondaryBody,
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
  groups: {
    gap: spacing.lg,
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
  iconTile: {
    alignItems: "center",
    backgroundColor: hai.pebble,
    borderRadius: 12,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowLabel: {
    color: colors.onyx,
    ...typography.body,
    fontWeight: "600",
  },
  rowMeta: {
    color: colors.slate,
    ...typography.monoMeta,
  },
  rowPressed: {
    backgroundColor: "rgba(34,32,29,0.04)",
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
    gap: spacing.sm,
  },
  stateTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
});
