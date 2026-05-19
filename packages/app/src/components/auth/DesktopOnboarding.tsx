import { useState } from "react";
import { ArrowLeft, Link2, Server, Sparkles, Mail } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { buildConfig } from "@/lib/build-config";
import { parseInviteTokenInput } from "@/lib/invite-deeplink";
import { saveServerConfig, type ServerConfig } from "@/lib/server-config";
import { useAppVersion } from "@/lib/version";
import { useAuthStore } from "@/stores/auth-store";
import { LoginScreen } from "./LoginScreen";

type Step = "welcome" | "choose" | "login" | "invite" | "server";

function Shell({ children }: { children: React.ReactNode }) {
  const appVersion = useAppVersion();
  return (
    <div className="relative flex min-h-screen flex-col bg-background px-6 py-8 text-foreground">
      <div className="absolute inset-x-0 top-0 h-12" data-tauri-drag-region />
      <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col">
        {children}
        <p className="mt-6 text-center font-mono text-[11px] text-faint">v{appVersion}</p>
      </div>
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-5 inline-flex w-fit items-center gap-1.5 rounded-[8px] px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-panel hover:text-foreground"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      {t("onboarding.common.back", "Back")}
    </button>
  );
}

function DetailFrame({
  children,
  onBack,
}: {
  children: React.ReactNode;
  onBack: () => void;
}) {
  return (
    <Shell>
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center">
        <BackButton onClick={onBack} />
        {children}
      </div>
    </Shell>
  );
}

function ChoiceRow({
  icon,
  title,
  caption,
  primary,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  caption: string;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-[14px] border border-border bg-paper p-3 text-left transition-colors hover:bg-selected/45 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span
        className={[
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]",
          primary ? "bg-coral text-white" : "bg-panel text-ink-2",
        ].join(" ")}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold text-foreground">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-5 text-muted-foreground">{caption}</span>
      </span>
    </button>
  );
}

function WelcomeStep({ onNext }: { onNext: () => void }) {
  const { t } = useTranslation();
  return (
    <Shell>
      <div className="flex flex-1 flex-col items-center justify-center text-center">
        <img src="/logo.png" alt={`${buildConfig.app.name} logo`} className="mb-5 h-20 w-20 object-contain" />
        <h1 className="text-[30px] font-semibold text-foreground">{buildConfig.app.name}</h1>
        <p className="mt-3 max-w-sm text-[14px] leading-6 text-ink-2">
          {t("auth.onboarding.tagline", "Choose how to enter TeamClaw.")}
        </p>
        <Button className="mt-8 bg-coral text-paper hover:bg-coral/90" onClick={onNext}>
          {t("auth.onboarding.getStarted", "Get started")}
        </Button>
      </div>
    </Shell>
  );
}

function ChooseStep({
  onQuickTrial,
  onLogin,
  onInvite,
  onServer,
}: {
  onQuickTrial: () => void;
  onLogin: () => void;
  onInvite: () => void;
  onServer: () => void;
}) {
  const { t } = useTranslation();
  const { loading, errorMessage } = useAuthStore();
  return (
    <Shell>
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center">
        <div className="mb-5">
          <h1 className="text-[24px] font-semibold text-foreground">
            {t("auth.onboarding.setupTitle", "Choose setup")}
          </h1>
          <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
            {t(
              "auth.onboarding.setupDesc",
              "Try it first, sign in, join a team, or connect a self-hosted server.",
            )}
          </p>
        </div>
        <div className="space-y-3">
          <ChoiceRow
            primary
            icon={<Sparkles className="h-4 w-4" />}
            title={t("auth.onboarding.quickTrial", "Quick trial")}
            caption={loading ? t("auth.onboarding.startingTrial", "Preparing…") : t("auth.onboarding.quickTrialDesc", "Enter anonymously, then join a team or bind an account later.")}
            disabled={loading}
            onClick={onQuickTrial}
          />
          <ChoiceRow
            icon={<Mail className="h-4 w-4" />}
            title={t("auth.onboarding.signInOrRegister", "Sign in or register")}
            caption={t("auth.onboarding.signInOrRegisterDesc", "Continue with an email code, matching the iOS flow.")}
            disabled={loading}
            onClick={onLogin}
          />
          <ChoiceRow
            icon={<Link2 className="h-4 w-4" />}
            title={t("auth.onboarding.joinTeam", "Join the team")}
            caption={t("auth.onboarding.joinTeamDesc", "Paste an invite link or token to join an existing team.")}
            disabled={loading}
            onClick={onInvite}
          />
          <ChoiceRow
            icon={<Server className="h-4 w-4" />}
            title={t("auth.onboarding.selfHosted", "Use self-hosted server")}
            caption={t("auth.onboarding.selfHostedDesc", "Configure Supabase and MQTT, then restart on your own server.")}
            disabled={loading}
            onClick={onServer}
          />
        </div>
        {errorMessage && (
          <p className="mt-4 rounded-[8px] border border-destructive/20 bg-paper px-3 py-2 text-[12px] leading-5 text-destructive">
            {errorMessage}
          </p>
        )}
      </div>
    </Shell>
  );
}

function InviteStep({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const { claimInviteAfterAnonymousSignIn, loading, errorMessage } = useAuthStore();
  const [raw, setRaw] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const token = parseInviteTokenInput(raw);
    if (!token) {
      setLocalError(t("auth.onboarding.inviteParseError", "Enter a valid invite token or invite link."));
      return;
    }
    setLocalError(null);
    await claimInviteAfterAnonymousSignIn(token);
  };

  return (
    <DetailFrame onBack={onBack}>
      <form onSubmit={submit} className="rounded-[16px] border border-border bg-paper p-5">
        <h1 className="text-[18px] font-semibold">{t("auth.onboarding.inviteTitle", "Join the team")}</h1>
        <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
          {t("auth.onboarding.inviteDesc", "Paste an invite link or token. We create an anonymous session first, then claim the invite.")}
        </p>
        <label className="mt-5 block space-y-2">
          <span className="text-[12px] font-medium text-ink-2">{t("auth.onboarding.inviteLabel", "Invite link or token")}</span>
          <Input value={raw} onChange={(event) => setRaw(event.target.value)} className="h-10 font-mono text-[12px]" />
        </label>
        {(localError || errorMessage) && (
          <p className="mt-3 text-[12px] text-destructive">{localError || errorMessage}</p>
        )}
        <Button type="submit" disabled={loading || !raw.trim()} className="mt-5 h-10 w-full bg-coral text-paper">
          {loading ? t("auth.onboarding.joining", "Joining…") : t("auth.onboarding.continue", "Continue")}
        </Button>
      </form>
    </DetailFrame>
  );
}

function ServerStep({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<ServerConfig>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (patch: Partial<ServerConfig>) => setConfig((current) => ({ ...current, ...patch }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const saved = await saveServerConfig(config);
      window.__TEAMCLAW_SERVER_CONFIG__ = saved;
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <DetailFrame onBack={onBack}>
      <form onSubmit={submit} className="rounded-[16px] border border-border bg-paper p-5">
        <h1 className="text-[18px] font-semibold">{t("auth.onboarding.serverTitle", "Self-hosted server")}</h1>
        <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
          {t("auth.onboarding.serverDesc", "Saving writes the local TeamClaw config and restarts the frontend so Supabase initializes again.")}
        </p>
        <div className="mt-5 grid gap-4">
          <label className="space-y-2">
            <span className="text-[12px] font-medium text-ink-2">{t("auth.onboarding.supabaseUrl", "Supabase URL")}</span>
            <Input value={config.supabaseUrl ?? ""} onChange={(event) => update({ supabaseUrl: event.target.value })} />
          </label>
          <label className="space-y-2">
            <span className="text-[12px] font-medium text-ink-2">{t("auth.onboarding.supabaseAnonKey", "Anon key")}</span>
            <Input value={config.supabaseAnonKey ?? ""} onChange={(event) => update({ supabaseAnonKey: event.target.value })} />
          </label>
          <label className="space-y-2">
            <span className="text-[12px] font-medium text-ink-2">{t("auth.onboarding.mqttHost", "MQTT host")}</span>
            <Input value={config.mqttHost ?? ""} onChange={(event) => update({ mqttHost: event.target.value })} />
          </label>
          <label className="space-y-2">
            <span className="text-[12px] font-medium text-ink-2">{t("auth.onboarding.mqttPort", "MQTT port")}</span>
            <Input
              type="number"
              value={config.mqttPort == null ? "" : String(config.mqttPort)}
              onChange={(event) => update({ mqttPort: event.target.value ? Number(event.target.value) : undefined })}
            />
          </label>
        </div>
        {error && <p className="mt-3 text-[12px] text-destructive">{error}</p>}
        <Button type="submit" disabled={saving} className="mt-5 h-10 w-full bg-coral text-paper">
          {saving ? t("auth.onboarding.savingServer", "Saving…") : t("auth.onboarding.saveServer", "Save and restart")}
        </Button>
      </form>
    </DetailFrame>
  );
}

export function DesktopOnboarding() {
  const [step, setStep] = useState<Step>("welcome");
  const signInAnonymously = useAuthStore((state) => state.signInAnonymously);

  if (step === "welcome") return <WelcomeStep onNext={() => setStep("choose")} />;
  if (step === "login") {
    return (
      <DetailFrame onBack={() => setStep("choose")}>
        <LoginScreen embedded />
      </DetailFrame>
    );
  }
  if (step === "invite") return <InviteStep onBack={() => setStep("choose")} />;
  if (step === "server") return <ServerStep onBack={() => setStep("choose")} />;

  return (
    <ChooseStep
      onQuickTrial={() => void signInAnonymously()}
      onLogin={() => setStep("login")}
      onInvite={() => setStep("invite")}
      onServer={() => setStep("server")}
    />
  );
}
