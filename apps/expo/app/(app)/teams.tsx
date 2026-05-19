import { Ionicons } from "@expo/vector-icons";
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
import { Hairline } from "../../src/ui/atoms/Hairline";
import { SectionEyebrow } from "../../src/ui/atoms/SectionEyebrow";
import { supabase } from "../../src/lib/supabase/client";
import { colors, hai, radii, spacing, typography } from "../../src/ui/theme";

type Membership = {
  teamId: string;
  name: string;
  slug: string;
  role: string;
};

export default function TeamsRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const memberActorId = state.currentMemberActorId;
  const activeTeamId = state.currentTeam?.id ?? "";
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (!memberActorId) {
          if (!cancelled) setIsLoading(false);
          return;
        }
        const result = (await supabase
          .from("team_members")
          .select("role, teams!inner(id, name, slug)")
          .eq("member_id", memberActorId)) as {
          data:
            | Array<{
                role: string | null;
                teams: { id: string; name: string | null; slug: string | null } | null;
              }>
            | null;
          error: { message?: string } | null;
        };
        if (cancelled) return;
        if (result.error) {
          setError(result.error.message ?? "Couldn't load teams.");
          setMemberships([]);
        } else {
          setMemberships(
            (result.data ?? [])
              .filter((row) => row.teams)
              .map((row) => ({
                teamId: row.teams!.id,
                name: row.teams!.name ?? "Unnamed team",
                slug: row.teams!.slug ?? "",
                role: row.role ?? "member",
              })),
          );
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Couldn't load teams.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [memberActorId]);

  return (
    <View style={styles.screen}>
      <View style={styles.headerBar}>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>Teams</Text>
        <Pressable hitSlop={8} onPress={() => router.back()} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </View>
      <Hairline />

      <ScrollView contentContainerStyle={styles.content}>
        {isLoading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.slate} />
            <Text style={styles.body}>Loading teams…</Text>
          </View>
        ) : error ? (
          <View style={styles.stateBlock}>
            <Text style={styles.stateTitle}>Couldn't load teams</Text>
            <Text style={styles.body}>{error}</Text>
          </View>
        ) : memberships.length === 0 ? (
          <View style={styles.stateBlock}>
            <Text style={styles.stateTitle}>No memberships</Text>
            <Text style={styles.body}>You're not on any teams yet.</Text>
          </View>
        ) : (
          <View style={styles.section}>
            <SectionEyebrow label={`MEMBER OF · ${memberships.length}`} style={styles.sectionEyebrow} />
            <View style={styles.card}>
              {memberships.map((membership, index) => {
                const isActive = membership.teamId === activeTeamId;
                return (
                  <View key={membership.teamId}>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => {
                        if (isActive) {
                          router.back();
                          return;
                        }
                        // Best-effort soft switch: refresh onboarding so it
                        // picks a new active team; the durable switch flow
                        // will land when the team picker stores the choice.
                        router.back();
                      }}
                      style={({ pressed }) => [
                        styles.row,
                        pressed ? styles.rowPressed : null,
                      ]}
                    >
                      <View style={styles.iconTile}>
                        <Text style={styles.iconText}>
                          {membership.name.charAt(0).toUpperCase()}
                        </Text>
                      </View>
                      <View style={styles.rowBody}>
                        <Text style={styles.rowLabel}>{membership.name}</Text>
                        <Text style={styles.rowMeta}>
                          {membership.slug || membership.teamId.slice(0, 8)} · {membership.role}
                        </Text>
                      </View>
                      {isActive ? (
                        <Ionicons
                          color={colors.cinnabar}
                          name="checkmark-circle"
                          size={20}
                        />
                      ) : (
                        <Ionicons color={colors.slate} name="chevron-forward" size={16} />
                      )}
                    </Pressable>
                    {index < memberships.length - 1 ? <Hairline /> : null}
                  </View>
                );
              })}
            </View>
            <Text style={styles.footnote}>
              Cross-team switching commits to the onboarding store in a
              follow-up — the picker surfaces every membership today so
              the user can audit their access.
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
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
  iconText: {
    color: hai.paper,
    fontSize: 16,
    fontWeight: "700",
  },
  iconTile: {
    alignItems: "center",
    backgroundColor: hai.onyx,
    borderRadius: 999,
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
