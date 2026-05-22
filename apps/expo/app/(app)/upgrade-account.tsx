import { Ionicons } from "@expo/vector-icons";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { useOnboarding } from "../_layout";
import { supabase } from "../../src/lib/supabase/client";
import type { OAuthProvider } from "../../src/features/onboarding/onboarding-oauth";
import { Hairline } from "../../src/ui/atoms/Hairline";
import { showToast } from "../../src/ui/Toast";
import { colors, hai, radii, spacing, typography } from "../../src/ui/theme";

WebBrowser.maybeCompleteAuthSession();

export default function UpgradeAccountRoute() {
  const router = useRouter();
  const { controller, state } = useOnboarding();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = isBusy || state.isBusy;

  const canSubmit =
    !busy &&
    email.trim().length > 0 &&
    /^\S+@\S+\.\S+$/.test(email.trim()) &&
    password.length >= 6;

  const handleUpgrade = async () => {
    if (!canSubmit) return;
    setIsBusy(true);
    setError(null);
    try {
      const result = await supabase.auth.updateUser({
        email: email.trim(),
        password,
      });
      if (result.error) {
        setError(result.error.message);
        return;
      }
      showToast(
        "success",
        "Account upgraded — check your inbox to verify the email.",
      );
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't upgrade account.");
    } finally {
      setIsBusy(false);
    }
  };

  const handleOAuthUpgrade = async (provider: OAuthProvider) => {
    if (busy) return;
    setError(null);
    try {
      await controller.linkIdentityWithOAuth(provider, {
        redirectTo: Linking.createURL("auth/callback"),
        openAuthSession: WebBrowser.openAuthSessionAsync,
      });
      showToast("success", "Account connected.");
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't connect account.");
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.headerBar}>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>Upgrade account</Text>
        <Pressable hitSlop={8} onPress={() => router.back()} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </View>
      <Hairline />

      <KeyboardAvoidingView
        behavior={Platform.select({ ios: "padding", default: undefined })}
        style={styles.body}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.lede}>
            {state.isAnonymous
              ? "Attach an email, Apple, or Google identity so you don't lose this workspace next time you launch Teamclaw."
              : "Change this account's email/password or connect another sign-in identity."}
          </Text>

          <View style={styles.card}>
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Email</Text>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
                keyboardType="email-address"
                onChangeText={setEmail}
                placeholder="you@example.com"
                placeholderTextColor={colors.slate}
                selectionColor={colors.cinnabar}
                style={styles.input}
                textContentType="emailAddress"
                value={email}
              />
            </View>
            <Hairline />
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Password</Text>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
                onChangeText={setPassword}
                placeholder="At least 6 characters"
                placeholderTextColor={colors.slate}
                secureTextEntry
                selectionColor={colors.cinnabar}
                style={styles.input}
                textContentType="newPassword"
                value={password}
              />
            </View>
          </View>

          {error || state.errorMessage ? (
            <Text style={styles.errorText}>{error ?? state.errorMessage}</Text>
          ) : null}

          <Pressable
            accessibilityRole="button"
            disabled={!canSubmit}
            onPress={handleUpgrade}
            style={({ pressed }) => [
              styles.cta,
              canSubmit ? styles.ctaActive : styles.ctaInactive,
              pressed && canSubmit ? styles.ctaPressed : null,
            ]}
          >
            {busy ? (
              <ActivityIndicator color={hai.paper} />
            ) : (
              <Text
                style={[
                  styles.ctaText,
                  canSubmit ? styles.ctaTextActive : styles.ctaTextInactive,
                ]}
              >
                Upgrade with Email
              </Text>
            )}
          </Pressable>

          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>or</Text>
            <View style={styles.dividerLine} />
          </View>

          <View style={styles.socialColumn}>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => {
                void handleOAuthUpgrade("apple");
              }}
              style={({ pressed }) => [
                styles.socialButton,
                pressed && !busy ? styles.pressed : null,
                busy ? styles.disabled : null,
              ]}
            >
              <View style={styles.socialIconWrap}>
                <Ionicons color={colors.onyx} name="logo-apple" size={19} />
              </View>
              <Text style={styles.socialLabel}>Upgrade with Apple</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => {
                void handleOAuthUpgrade("google");
              }}
              style={({ pressed }) => [
                styles.socialButton,
                pressed && !busy ? styles.pressed : null,
                busy ? styles.disabled : null,
              ]}
            >
              <View style={styles.socialIconWrap}>
                <Ionicons color={colors.onyx} name="globe-outline" size={19} />
              </View>
              <Text style={styles.socialLabel}>Upgrade with Google</Text>
            </Pressable>
          </View>

          <Text style={styles.footnote}>
            After upgrading, sign in with the same identity next time you
            launch Teamclaw. Existing teams, agents, and sessions stay
            attached.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
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
  disabled: {
    opacity: 0.5,
  },
  divider: {
    alignItems: "center",
    flexDirection: "row",
    gap: 14,
  },
  dividerLine: {
    backgroundColor: colors.hairline,
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  dividerText: {
    color: colors.slate,
    ...typography.caption,
  },
  errorText: {
    color: hai.cinnabarDeep,
    paddingHorizontal: spacing.xs,
    ...typography.caption,
  },
  field: {
    gap: spacing.xs,
    padding: spacing.md,
  },
  fieldLabel: {
    color: colors.slate,
    ...typography.monoMeta,
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
    padding: 0,
    ...typography.body,
  },
  lede: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  pressed: {
    opacity: 0.8,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  socialButton: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 13,
  },
  socialColumn: {
    gap: spacing.sm,
  },
  socialIconWrap: {
    alignItems: "center",
    backgroundColor: colors.mist,
    borderRadius: 999,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  socialLabel: {
    color: colors.onyx,
    ...typography.body,
    fontWeight: "600",
  },
});
