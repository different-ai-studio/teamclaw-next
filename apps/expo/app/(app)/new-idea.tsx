import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useState } from "react";
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

export default function NewIdeaRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const teamId = state.currentTeam?.id ?? "";
  const memberActorId = state.currentMemberActorId;

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canCreate =
    !isBusy && Boolean(teamId) && Boolean(memberActorId) && title.trim().length > 0;

  const handleCreate = async () => {
    if (!canCreate) return;
    setIsBusy(true);
    setError(null);
    try {
      const result = (await supabase
        .from("ideas")
        .insert({
          team_id: teamId,
          created_by_actor_id: memberActorId,
          title: title.trim(),
          description: description.trim(),
          status: "open",
          archived: false,
        })
        .select("id")
        .single()) as {
        data: { id?: string } | null;
        error: { message?: string } | null;
      };
      if (result.error) {
        setError(result.error.message ?? "Couldn't create idea.");
        return;
      }
      router.back();
      const id = result.data?.id;
      if (id) {
        router.push(`/(app)/idea-detail?ideaId=${id}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create idea.");
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.headerBar}>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>New Idea</Text>
        <Pressable hitSlop={8} onPress={() => router.back()} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </View>
      <Hairline />

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.section}>
          <SectionEyebrow label="TITLE" style={styles.sectionEyebrow} />
          <View style={styles.card}>
            <TextInput
              autoCapitalize="sentences"
              autoCorrect={true}
              editable={!isBusy}
              maxLength={120}
              onChangeText={setTitle}
              placeholder="Sum up the idea in a sentence"
              placeholderTextColor={colors.slate}
              selectionColor={colors.cinnabar}
              style={styles.titleInput}
              value={title}
            />
          </View>
        </View>

        <View style={styles.section}>
          <SectionEyebrow label="DESCRIPTION" style={styles.sectionEyebrow} />
          <View style={styles.card}>
            <TextInput
              editable={!isBusy}
              multiline
              onChangeText={setDescription}
              placeholder="What does it look like? Who's it for?"
              placeholderTextColor={colors.slate}
              selectionColor={colors.cinnabar}
              style={styles.descriptionInput}
              value={description}
            />
          </View>
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <Pressable
          accessibilityRole="button"
          disabled={!canCreate}
          onPress={handleCreate}
          style={({ pressed }) => [
            styles.cta,
            canCreate ? styles.ctaActive : styles.ctaInactive,
            pressed && canCreate ? styles.ctaPressed : null,
          ]}
        >
          {isBusy ? (
            <ActivityIndicator color={hai.paper} />
          ) : (
            <Text
              style={[styles.ctaText, canCreate ? styles.ctaTextActive : styles.ctaTextInactive]}
            >
              Create idea
            </Text>
          )}
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
  },
  content: {
    gap: spacing.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  cta: {
    alignItems: "center",
    borderRadius: radii.button,
    paddingVertical: 14,
  },
  ctaActive: {
    backgroundColor: hai.cinnabar,
  },
  ctaInactive: {
    backgroundColor: hai.pebble,
  },
  ctaPressed: {
    opacity: 0.88,
  },
  ctaText: {
    ...typography.cardTitle,
  },
  ctaTextActive: {
    color: hai.paper,
  },
  ctaTextInactive: {
    color: hai.slate,
  },
  descriptionInput: {
    color: colors.onyx,
    minHeight: 96,
    padding: 0,
    textAlignVertical: "top",
    ...typography.body,
  },
  errorText: {
    color: hai.cinnabarDeep,
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
  titleInput: {
    color: colors.onyx,
    padding: 0,
    ...typography.cardTitle,
  },
});
