import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";

import { Hairline } from "../../src/ui/atoms/Hairline";
import { SectionEyebrow } from "../../src/ui/atoms/SectionEyebrow";
import { colors, radii, spacing, typography } from "../../src/ui/theme";

const STORAGE_KEY = "teamclaw.notificationPrefs.v1";

type Prefs = {
  agentReply: boolean;
  mention: boolean;
  newSession: boolean;
  ideaUpdate: boolean;
};

const DEFAULT_PREFS: Prefs = {
  agentReply: true,
  mention: true,
  newSession: false,
  ideaUpdate: false,
};

export default function NotificationsRoute() {
  const router = useRouter();
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (!cancelled && raw) {
          const parsed = JSON.parse(raw);
          setPrefs({ ...DEFAULT_PREFS, ...parsed });
        }
      } catch {
        // fall through with defaults
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const update = async (patch: Partial<Prefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // best-effort persistence
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.headerBar}>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>Notifications</Text>
        <Pressable hitSlop={8} onPress={() => router.back()} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </View>
      <Hairline />

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.section}>
          <SectionEyebrow label="MESSAGES" style={styles.sectionEyebrow} />
          <View style={styles.card}>
            <ToggleRow
              disabled={!hydrated}
              helper="Notify me when an agent finishes a turn."
              label="Agent replies"
              onChange={(value) => update({ agentReply: value })}
              value={prefs.agentReply}
            />
            <Hairline />
            <ToggleRow
              disabled={!hydrated}
              helper="Ping me when someone @mentions me in any session."
              label="@mentions"
              onChange={(value) => update({ mention: value })}
              value={prefs.mention}
            />
          </View>
        </View>

        <View style={styles.section}>
          <SectionEyebrow label="ACTIVITY" style={styles.sectionEyebrow} />
          <View style={styles.card}>
            <ToggleRow
              disabled={!hydrated}
              helper="Let me know when a teammate spins up a new session."
              label="New sessions"
              onChange={(value) => update({ newSession: value })}
              value={prefs.newSession}
            />
            <Hairline />
            <ToggleRow
              disabled={!hydrated}
              helper="Track status changes on ideas I created or commented on."
              label="Idea updates"
              onChange={(value) => update({ ideaUpdate: value })}
              value={prefs.ideaUpdate}
            />
          </View>
        </View>

        <Text style={styles.footnote}>
          Preferences live on this device until APNs/FCM registration lands —
          the toggle state is honored locally by future notification scheduling.
        </Text>
      </ScrollView>
    </View>
  );
}

function ToggleRow({
  disabled,
  helper,
  label,
  onChange,
  value,
}: {
  disabled?: boolean;
  helper: string;
  label: string;
  onChange: (value: boolean) => void;
  value: boolean;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowBody}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowHelper}>{helper}</Text>
      </View>
      <Switch
        disabled={disabled}
        onValueChange={onChange}
        thumbColor={value ? colors.paper : colors.paper}
        trackColor={{ false: colors.pebble, true: colors.cinnabar }}
        value={value}
      />
    </View>
  );
}

const styles = StyleSheet.create({
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
  footnote: {
    color: colors.slate,
    paddingHorizontal: spacing.xs,
    ...typography.caption,
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
  rowHelper: {
    color: colors.slate,
    ...typography.caption,
  },
  rowLabel: {
    color: colors.onyx,
    ...typography.body,
    fontWeight: "600",
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
});
