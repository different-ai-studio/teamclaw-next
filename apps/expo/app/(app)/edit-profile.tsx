import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
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

export default function EditProfileRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const memberActorId = state.currentMemberActorId;
  const teamId = state.currentTeam?.id ?? "";

  const [displayName, setDisplayName] = useState("");
  const [initialName, setInitialName] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!teamId || !memberActorId) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await supabase
          .from("actors")
          .select("display_name")
          .eq("id", memberActorId)
          .maybeSingle();
        if (cancelled) return;
        if (result.error) {
          setError(result.error.message);
        } else {
          const name = (result.data as { display_name?: string } | null)?.display_name ?? "";
          setDisplayName(name);
          setInitialName(name);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Couldn't load your profile.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [memberActorId, teamId]);

  const canSave =
    !isSaving &&
    !isLoading &&
    displayName.trim().length > 0 &&
    displayName.trim() !== initialName.trim();

  const handleSave = async () => {
    if (!memberActorId || !canSave) return;
    setIsSaving(true);
    setError(null);
    try {
      const result = await supabase
        .from("actors")
        .update({
          display_name: displayName.trim(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", memberActorId);
      if (result.error) {
        setError(result.error.message);
        setIsSaving(false);
        return;
      }
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save your profile.");
      setIsSaving(false);
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.headerBar}>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>Edit Profile</Text>
        <Pressable hitSlop={8} onPress={() => router.back()} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </View>
      <Hairline />

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {isLoading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.slate} />
            <Text style={styles.body}>Loading profile…</Text>
          </View>
        ) : !memberActorId ? (
          <View style={styles.stateBlock}>
            <Text style={styles.stateTitle}>Not a member yet</Text>
            <Text style={styles.body}>Finish onboarding before editing your profile.</Text>
          </View>
        ) : (
          <>
            <View style={styles.section}>
              <SectionEyebrow label="DISPLAY NAME" style={styles.sectionEyebrow} />
              <View style={styles.card}>
                <TextInput
                  autoCapitalize="words"
                  autoCorrect={false}
                  editable={!isSaving}
                  maxLength={64}
                  onChangeText={setDisplayName}
                  placeholder="How you'd like teammates to address you"
                  placeholderTextColor={colors.slate}
                  selectionColor={colors.cinnabar}
                  style={styles.input}
                  value={displayName}
                />
              </View>
              <Text style={styles.footnote}>
                This is the name agents and teammates see when you appear in a
                session.
              </Text>
            </View>

            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            <Pressable
              accessibilityRole="button"
              disabled={!canSave}
              onPress={handleSave}
              style={({ pressed }) => [
                styles.cta,
                canSave ? styles.ctaActive : styles.ctaInactive,
                pressed && canSave ? styles.ctaPressed : null,
              ]}
            >
              <Text style={[styles.ctaText, canSave ? styles.ctaTextActive : styles.ctaTextInactive]}>
                {isSaving ? "Saving…" : "Save changes"}
              </Text>
            </Pressable>
          </>
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
  errorText: {
    color: hai.cinnabarDeep,
    ...typography.caption,
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
  input: {
    color: colors.onyx,
    minHeight: 24,
    padding: 0,
    ...typography.body,
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
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
