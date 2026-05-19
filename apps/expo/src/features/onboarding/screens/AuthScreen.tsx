import { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { PrimaryButton } from "../../../ui/button";
import { AppCard } from "../../../ui/card";
import { AppInput } from "../../../ui/input";
import { colors, radii, spacing, typography } from "../../../ui/theme";
import { getOtpValidationError, OTP_CODE_LENGTH, sanitizeOtpInput } from "../auth-otp";

type AuthScreenProps = {
  errorMessage: string | null;
  isBusy: boolean;
  pendingEmail: string | null;
  onBack: () => void;
  onRequestOtp: (email: string) => Promise<void>;
  onSignInAnonymously: () => Promise<void>;
  onVerifyOtp: (token: string) => Promise<void>;
};

function isValidEmail(value: string) {
  return /\S+@\S+\.\S+/.test(value);
}

export function AuthScreen({
  errorMessage,
  isBusy,
  pendingEmail,
  onBack,
  onRequestOtp,
  onSignInAnonymously,
  onVerifyOtp,
}: AuthScreenProps) {
  const [email, setEmail] = useState(pendingEmail ?? "");
  const [otpCode, setOtpCode] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [isServerErrorDismissed, setIsServerErrorDismissed] = useState(false);

  useEffect(() => {
    if (pendingEmail) {
      setEmail(pendingEmail);
    }
  }, [pendingEmail]);

  useEffect(() => {
    if (errorMessage === null) {
      setIsServerErrorDismissed(false);
    }
  }, [errorMessage]);

  const requestCode = async () => {
    const nextEmail = email.trim().toLowerCase();
    if (!isValidEmail(nextEmail)) {
      setLocalError("Enter a valid email address.");
      return;
    }

    setLocalError(null);
    setIsServerErrorDismissed(false);

    try {
      await onRequestOtp(nextEmail);
    } catch {}
  };

  const verifyCode = async () => {
    const nextCode = otpCode.trim();
    const validationError = getOtpValidationError(nextCode);
    if (validationError) {
      setLocalError(validationError);
      return;
    }

    setLocalError(null);
    setIsServerErrorDismissed(false);

    try {
      await onVerifyOtp(nextCode);
    } catch {}
  };

  const signInAsGuest = async () => {
    setLocalError(null);
    setIsServerErrorDismissed(false);

    try {
      await onSignInAnonymously();
    } catch {}
  };

  const visibleError =
    localError ?? (isServerErrorDismissed ? null : errorMessage);
  const activeEmail = pendingEmail ?? email.trim().toLowerCase();

  return (
    <KeyboardAvoidingView
      behavior={Platform.select({ ios: "padding", default: undefined })}
      style={styles.screen}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Pressable onPress={onBack} style={({ pressed }) => [styles.backLink, pressed && styles.pressed]}>
          <Text style={styles.backText}>Back</Text>
        </Pressable>

        <View style={styles.header}>
          <Text style={styles.title}>Join TeamClaw</Text>
          <Text style={styles.body}>
            Continue with a guest session, or ask for a one-time code by email.
          </Text>
        </View>

        <AppCard elevated style={styles.card}>
          <AppInput
            autoCapitalize="none"
            autoComplete="email"
            editable={!isBusy}
            keyboardType="email-address"
            label="Work email"
            onChangeText={(value) => {
              setEmail(value);
              if (localError) {
                setLocalError(null);
              }
              if (errorMessage) {
                setIsServerErrorDismissed(true);
              }
            }}
            placeholder="name@company.com"
            value={email}
          />

          {pendingEmail ? (
            <>
              <Text style={styles.helper}>
                We sent a login code to <Text style={styles.helperStrong}>{activeEmail}</Text>.
              </Text>
              <AppInput
                editable={!isBusy}
                keyboardType="number-pad"
                label="One-time code"
                maxLength={OTP_CODE_LENGTH}
                onChangeText={(value) => {
                  setOtpCode(sanitizeOtpInput(value));
                  if (localError) {
                    setLocalError(null);
                  }
                  if (errorMessage) {
                    setIsServerErrorDismissed(true);
                  }
                }}
                placeholder="12345678"
                value={otpCode}
              />
            </>
          ) : null}

          {visibleError ? <Text style={styles.error}>{visibleError}</Text> : null}

          <PrimaryButton
            isLoading={isBusy}
            label={pendingEmail ? "Verify and continue" : "Send login code"}
            onPress={() => {
              void (pendingEmail ? verifyCode() : requestCode());
            }}
          />

          {pendingEmail ? (
            <Pressable
              disabled={isBusy}
              onPress={() => {
                void requestCode();
              }}
              style={({ pressed }) => [
                styles.secondaryButton,
                pressed && !isBusy && styles.pressed,
                isBusy && styles.disabled,
              ]}
            >
              <Text style={styles.secondaryButtonText}>Resend code</Text>
            </Pressable>
          ) : null}
        </AppCard>

        <AppCard compact style={styles.card}>
          <Text style={styles.cardTitle}>Try the product first</Text>
          <Text style={styles.cardBody}>
            Guest mode creates an anonymous session so you can set up a team before connecting
            a full account.
          </Text>
          <Pressable
            disabled={isBusy}
            onPress={() => {
              void signInAsGuest();
            }}
            style={({ pressed }) => [
              styles.secondaryButton,
              pressed && !isBusy && styles.pressed,
              isBusy && styles.disabled,
            ]}
          >
            <Text style={styles.secondaryButtonText}>Continue as guest</Text>
          </Pressable>
        </AppCard>

        <AppCard compact style={styles.oauthCard}>
          <Text style={styles.cardTitle}>More sign-in options</Text>
          <Text style={styles.cardBody}>
            Apple and Google sign-in will live here later. For now, use email code or guest
            access.
          </Text>
          <View style={styles.oauthRow}>
            <View style={styles.oauthPill}>
              <Text style={styles.oauthText}>Apple coming soon</Text>
            </View>
            <View style={styles.oauthPill}>
              <Text style={styles.oauthText}>Google coming soon</Text>
            </View>
          </View>
        </AppCard>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  backLink: {
    alignSelf: "flex-start",
  },
  backText: {
    color: colors.mutedForeground,
    ...typography.caption,
  },
  body: {
    color: colors.ink2,
    ...typography.body,
  },
  card: {
    gap: spacing.md,
  },
  cardBody: {
    color: colors.ink2,
    ...typography.secondaryBody,
  },
  cardTitle: {
    color: colors.foreground,
    ...typography.cardTitle,
  },
  content: {
    gap: spacing.lg,
    padding: spacing.xxl,
  },
  disabled: {
    opacity: 0.4,
  },
  error: {
    color: colors.danger,
    ...typography.caption,
  },
  header: {
    gap: spacing.sm,
  },
  helper: {
    color: colors.ink2,
    ...typography.secondaryBody,
  },
  helperStrong: {
    color: colors.foreground,
    ...typography.monoMeta,
  },
  oauthCard: {
    gap: spacing.sm,
  },
  oauthPill: {
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderRadius: radii.pill,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  oauthRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  oauthText: {
    color: colors.mutedForeground,
    ...typography.secondaryBody,
  },
  pressed: {
    opacity: 0.8,
  },
  screen: {
    backgroundColor: colors.background,
    flex: 1,
  },
  secondaryButton: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: radii.button,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  secondaryButtonText: {
    color: colors.foreground,
    ...typography.cardTitle,
  },
  title: {
    color: colors.foreground,
    ...typography.sectionTitle,
  },
});
