import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { useOnboarding } from "../_layout";
import { Hairline } from "../../src/ui/atoms/Hairline";
import { SectionEyebrow } from "../../src/ui/atoms/SectionEyebrow";
import { supabase } from "../../src/lib/supabase/client";
import { colors, hai, radii, spacing, typography } from "../../src/ui/theme";

type WorkspaceRow = {
  id: string;
  name: string;
  archived: boolean;
};

export default function WorkspacesRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const teamId = state.currentTeam?.id ?? "";
  const memberActorId = state.currentMemberActorId;
  const [rows, setRows] = useState<WorkspaceRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createDraft, setCreateDraft] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!teamId) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const result = await supabase
        .from("workspaces")
        .select("id, name, archived")
        .eq("team_id", teamId)
        .order("name", { ascending: true });
      if (result.error) {
        setError(result.error.message);
        setRows([]);
      } else {
        setRows((result.data ?? []) as WorkspaceRow[]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load workspaces.");
    } finally {
      setIsLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    let cancelled = false;
    void load().catch(() => {
      // load already surfaces errors
    });
    return () => {
      cancelled = true;
      void cancelled;
    };
  }, [load]);

  const handleCreate = async () => {
    if (!teamId || !memberActorId) return;
    const name = createDraft.trim();
    if (!name) return;
    setIsCreating(true);
    setCreateError(null);
    try {
      const result = await supabase.from("workspaces").insert({
        team_id: teamId,
        created_by_member_id: memberActorId,
        name,
        archived: false,
      });
      if (result.error) {
        setCreateError(result.error.message);
      } else {
        setCreateDraft("");
        await load();
      }
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Couldn't create workspace.");
    } finally {
      setIsCreating(false);
    }
  };

  const active = rows.filter((row) => !row.archived);
  const archived = rows.filter((row) => row.archived);

  return (
    <View style={styles.screen}>
      <View style={styles.headerBar}>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>Workspaces</Text>
        <Pressable hitSlop={8} onPress={() => router.back()} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </View>
      <Hairline />

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.section}>
          <SectionEyebrow label="NEW WORKSPACE" style={styles.sectionEyebrow} />
          <View style={styles.card}>
            <View style={styles.createRow}>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                editable={!isCreating}
                onChangeText={setCreateDraft}
                placeholder="workspace-name"
                placeholderTextColor={colors.slate}
                selectionColor={colors.cinnabar}
                style={styles.createInput}
                value={createDraft}
              />
              <Pressable
                accessibilityRole="button"
                disabled={isCreating || createDraft.trim().length === 0 || !memberActorId}
                onPress={handleCreate}
                style={({ pressed }) => [
                  styles.createButton,
                  createDraft.trim().length > 0 && !isCreating
                    ? styles.createButtonActive
                    : styles.createButtonIdle,
                  pressed && createDraft.trim().length > 0 ? styles.createButtonPressed : null,
                ]}
              >
                <Text
                  style={[
                    styles.createButtonText,
                    createDraft.trim().length > 0 && !isCreating
                      ? styles.createButtonTextActive
                      : styles.createButtonTextIdle,
                  ]}
                >
                  {isCreating ? "Creating…" : "Create"}
                </Text>
              </Pressable>
            </View>
          </View>
          {createError ? <Text style={styles.errorText}>{createError}</Text> : null}
        </View>

        {isLoading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.slate} />
            <Text style={styles.body}>Loading workspaces…</Text>
          </View>
        ) : error ? (
          <View style={styles.stateBlock}>
            <Text style={styles.stateTitle}>Couldn't load workspaces</Text>
            <Text style={styles.body}>{error}</Text>
          </View>
        ) : rows.length === 0 ? (
          <View style={styles.stateBlock}>
            <Text style={styles.stateTitle}>No workspaces</Text>
            <Text style={styles.body}>
              Workspaces show up here once an agent connects to one.
            </Text>
          </View>
        ) : (
          <View style={styles.groups}>
            <View style={styles.section}>
              <SectionEyebrow
                label={`ACTIVE · ${active.length}`}
                style={styles.sectionEyebrow}
              />
              <View style={styles.card}>
                {active.map((row, index) => (
                  <View key={row.id}>
                    <View style={styles.row}>
                      <Text style={styles.rowLabel}>{row.name || row.id}</Text>
                    </View>
                    {index < active.length - 1 ? <Hairline /> : null}
                  </View>
                ))}
              </View>
            </View>
            {archived.length > 0 ? (
              <View style={styles.section}>
                <SectionEyebrow
                  label={`ARCHIVED · ${archived.length}`}
                  style={styles.sectionEyebrow}
                />
                <View style={styles.card}>
                  {archived.map((row, index) => (
                    <View key={row.id}>
                      <View style={styles.row}>
                        <Text style={styles.rowLabelArchived}>{row.name || row.id}</Text>
                      </View>
                      {index < archived.length - 1 ? <Hairline /> : null}
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
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
  createButton: {
    alignItems: "center",
    borderRadius: radii.button,
    justifyContent: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  createButtonActive: {
    backgroundColor: hai.cinnabar,
  },
  createButtonIdle: {
    backgroundColor: hai.pebble,
  },
  createButtonPressed: {
    opacity: 0.88,
  },
  createButtonText: {
    ...typography.caption,
    fontWeight: "700",
  },
  createButtonTextActive: {
    color: hai.paper,
  },
  createButtonTextIdle: {
    color: hai.slate,
  },
  createInput: {
    color: colors.onyx,
    flex: 1,
    padding: 0,
    ...typography.body,
  },
  createRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md,
  },
  errorText: {
    color: hai.cinnabarDeep,
    paddingHorizontal: spacing.xs,
    ...typography.caption,
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
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  rowLabel: {
    color: colors.onyx,
    ...typography.body,
  },
  rowLabelArchived: {
    color: colors.slate,
    ...typography.body,
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
