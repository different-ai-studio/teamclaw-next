import * as React from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Database, Loader2, Save, Server, Wifi, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { mqttConnect, mqttStatus } from "@/lib/mqtt-bridge";
import { resolveCurrentMemberActorId } from "@/lib/current-actor";
import { useAuthStore } from "@/stores/auth-store";
import { useCurrentTeamStore } from "@/stores/current-team";
import { useSessionListStore } from "@/stores/session-list-store";
import {
  getEffectiveServerConfig,
  getSavedServerConfig,
  saveServerConfig,
  type ServerConfig,
} from "@/lib/server-config";
import { SectionHeader, SettingCard } from "./shared";

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "password" | "number";
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[12px] font-medium text-muted-foreground">{label}</span>
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type={type}
        autoComplete="off"
        className="rounded-[8px] border-border bg-background font-mono text-[12.5px] text-foreground placeholder:text-faint"
      />
    </label>
  );
}

type ProbeState = "idle" | "testing" | "ok" | "error";

function StatusPill({
  state,
  label,
  detail,
}: {
  state: ProbeState;
  label: string;
  detail?: string | null;
}) {
  const ok = state === "ok";
  const testing = state === "testing";
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-[10px] border px-3 py-2 text-[12px]",
        ok
          ? "border-green-200 bg-green-50 text-green-700"
          : state === "error"
            ? "border-red-200 bg-red-50 text-red-700"
            : "border-border-soft bg-background text-muted-foreground",
      )}
    >
      <span className="inline-flex min-w-0 items-center gap-2">
        {testing ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        ) : ok ? (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        ) : state === "error" ? (
          <XCircle className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <span className="h-2 w-2 shrink-0 rounded-full bg-faint" />
        )}
        <span className="font-medium">{label}</span>
      </span>
      {detail && <span className="truncate font-mono text-[11px] opacity-80">{detail}</span>}
    </div>
  );
}

function trimConfig(config: ServerConfig): ServerConfig {
  return {
    supabaseUrl: config.supabaseUrl?.trim() || undefined,
    supabaseAnonKey: config.supabaseAnonKey?.trim() || undefined,
    mqttHost: config.mqttHost?.trim() || undefined,
    mqttPort: config.mqttPort,
    mqttUseTls: config.mqttUseTls,
  };
}

export function ServerSection() {
  const { t } = useTranslation();
  const [saved, setSaved] = React.useState<ServerConfig>({});
  const [effective, setEffective] = React.useState<ServerConfig>({});
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [mqttProbe, setMqttProbe] = React.useState<{ state: ProbeState; message?: string | null }>({
    state: "idle",
  });

  const loadConfig = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [savedConfig, effectiveConfig] = await Promise.all([
        getSavedServerConfig(),
        getEffectiveServerConfig(),
      ]);
      setSaved(trimConfig(savedConfig));
      setEffective(trimConfig(effectiveConfig));
      try {
        const status = await mqttStatus();
        setMqttProbe({
          state: status.connected ? "ok" : "idle",
          message: status.connected ? t("settings.server.mqttConnected", "Connected") : null,
        });
      } catch {
        setMqttProbe({ state: "idle" });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [t]);

  React.useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  // Live-update the connection badge when the Rust event loop emits
  // mqtt:connected events. Without this, the badge only refreshes when
  // the user re-opens the settings panel — so a connection that died
  // mid-session keeps showing "connected" until the next visit.
  React.useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      if (cancelled) return;
      const off = await listen<boolean>("mqtt:connected", (event) => {
        setMqttProbe({
          state: event.payload ? "ok" : "idle",
          message: event.payload ? t("settings.server.mqttConnected", "Connected") : null,
        });
      });
      if (cancelled) {
        off();
        return;
      }
      unlisten = off;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [t]);

  const updateSaved = React.useCallback((patch: Partial<ServerConfig>) => {
    setSaved((current) => trimConfig({ ...current, ...patch }));
  }, []);

  const testMqttConnection = React.useCallback(async () => {
    const config = await getEffectiveServerConfig();
    if (!config.mqttHost) {
      setMqttProbe({ state: "error", message: t("settings.server.mqttMissingHost", "MQTT host is missing") });
      return false;
    }

    const session = useAuthStore.getState().session;
    const userId = session?.user.id ?? null;
    const accessToken = session?.access_token ?? null;
    const teamId =
      useCurrentTeamStore.getState().team?.id ??
      useSessionListStore.getState().rows[0]?.team_id ??
      null;
    if (!userId || !accessToken || !teamId) {
      setMqttProbe({
        state: "error",
        message: t("settings.server.mqttMissingSession", "Sign in and select a team before testing MQTT"),
      });
      return false;
    }

    setMqttProbe({ state: "testing", message: t("settings.server.testing", "Testing...") });
    try {
      const actorId = await resolveCurrentMemberActorId(teamId, userId, {
        currentTeamId: useCurrentTeamStore.getState().team?.id ?? null,
        currentMemberId: useCurrentTeamStore.getState().currentMember?.id ?? null,
      });
      if (!actorId) {
        throw new Error(t("settings.server.mqttMissingActor", "No member actor found for this team"));
      }

      const useTls = config.mqttUseTls ?? false;
      await mqttConnect({
        brokerHost: config.mqttHost,
        brokerPort: config.mqttPort ?? 1883,
        username: actorId,
        password: accessToken,
        clientId: `teamclaw-settings-${actorId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
        teamId,
        useTls,
      });
      const scheme = useTls ? "mqtts" : "mqtt";
      setMqttProbe({
        state: "ok",
        message: `${scheme}://${config.mqttHost}:${config.mqttPort ?? 1883}`,
      });
      return true;
    } catch (e) {
      setMqttProbe({ state: "error", message: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }, [t]);

  const handleSave = React.useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const savedConfig = await saveServerConfig(saved);
      const effectiveConfig = await getEffectiveServerConfig();
      setSaved(trimConfig(savedConfig));
      setEffective(trimConfig(effectiveConfig));
      const connected = await testMqttConnection();
      toast.success(
        connected
          ? t("settings.server.savedAndTested", "Server settings saved and MQTT connected")
          : t("settings.server.saved", "Server settings saved"),
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      toast.error(t("settings.server.saveError", "Failed to save server settings"));
    } finally {
      setSaving(false);
    }
  }, [saved, t, testMqttConnection]);

  const mqttPortText = saved.mqttPort == null ? "" : String(saved.mqttPort);

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Server}
        title={t("settings.server.title", "Server")}
        description={t(
          "settings.server.description",
          "Configure the Supabase project and MQTT broker used by the desktop app.",
        )}
      />

      {error && (
        <div className="rounded-[14px] border border-red-200 bg-red-50 px-4 py-3 text-[12.5px] text-red-700">
          {error}
        </div>
      )}

      <SettingCard>
        <div className="mb-4 flex items-center gap-2">
          <Database className="h-4 w-4 text-muted-foreground" />
          <h4 className="text-[13px] font-semibold">{t("settings.server.supabaseTitle", "Supabase")}</h4>
        </div>
        <div className="mb-4">
          <StatusPill
            state={effective.supabaseUrl && effective.supabaseAnonKey ? "ok" : "error"}
            label={
              effective.supabaseUrl && effective.supabaseAnonKey
                ? t("settings.server.supabaseConfigured", "Configured")
                : t("settings.server.supabaseMissing", "Missing configuration")
            }
            detail={effective.supabaseUrl}
          />
        </div>
        <div className="space-y-4">
          <Field
            label={t("settings.server.supabaseUrl", "Project URL")}
            value={saved.supabaseUrl ?? ""}
            onChange={(value) => updateSaved({ supabaseUrl: value })}
            placeholder={effective.supabaseUrl || "https://xxxx.supabase.co"}
          />
          <Field
            label={t("settings.server.supabaseAnonKey", "Anon key")}
            value={saved.supabaseAnonKey ?? ""}
            onChange={(value) => updateSaved({ supabaseAnonKey: value })}
            placeholder={effective.supabaseAnonKey ? "••••••••" : "eyJ..."}
            type="password"
          />
          <p className="text-[12px] leading-5 text-muted-foreground">
            {t(
              "settings.server.supabaseHint",
              "Saved values override build-time environment values after the app has loaded.",
            )}
          </p>
        </div>
      </SettingCard>

      <SettingCard>
        <div className="mb-4 flex items-center gap-2">
          <Wifi className="h-4 w-4 text-muted-foreground" />
          <h4 className="text-[13px] font-semibold">{t("settings.server.mqttTitle", "MQTT")}</h4>
        </div>
        <div className="mb-4">
          <StatusPill
            state={mqttProbe.state}
            label={
              mqttProbe.state === "ok"
                ? t("settings.server.mqttConnected", "Connected")
                : mqttProbe.state === "testing"
                  ? t("settings.server.testing", "Testing...")
                  : mqttProbe.state === "error"
                    ? t("settings.server.mqttDisconnected", "Not connected")
                    : t("settings.server.mqttNotTested", "Not tested")
            }
            detail={mqttProbe.message}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
          <Field
            label={t("settings.server.mqttHost", "Broker host")}
            value={saved.mqttHost ?? ""}
            onChange={(value) => updateSaved({ mqttHost: value })}
            placeholder={effective.mqttHost || "mqtt.example.com"}
          />
          <Field
            label={t("settings.server.mqttPort", "Port")}
            value={mqttPortText}
            onChange={(value) => {
              const parsed = Number(value);
              updateSaved({ mqttPort: value === "" || !Number.isFinite(parsed) ? undefined : parsed });
            }}
            placeholder={effective.mqttPort == null ? "1883" : String(effective.mqttPort)}
            type="number"
          />
        </div>
        <label className="mt-4 flex items-center justify-between gap-3 rounded-[10px] border border-border-soft bg-background px-3 py-2">
          <div className="min-w-0">
            <div className="text-[12.5px] font-medium text-foreground">
              {t("settings.server.mqttUseTls", "Use TLS (mqtts://)")}
            </div>
            <div className="text-[11.5px] text-muted-foreground">
              {t(
                "settings.server.mqttUseTlsHint",
                "Enable for brokers on port 8883. Disable for plain TCP on 1883.",
              )}
            </div>
          </div>
          <Switch
            checked={saved.mqttUseTls ?? effective.mqttUseTls ?? false}
            onCheckedChange={(checked) => updateSaved({ mqttUseTls: checked })}
          />
        </label>
      </SettingCard>

      <div className="flex items-center justify-between gap-3">
        <p className="text-[12px] text-muted-foreground">
          {loading
            ? t("settings.server.loading", "Loading server settings...")
            : t("settings.server.restartHint", "Reconnect or restart the app after changing MQTT settings.")}
        </p>
        <Button
          type="button"
          onClick={handleSave}
          disabled={loading || saving}
          className={cn("h-8 rounded-[8px] px-3 text-[12.5px] font-semibold")}
        >
          {saving ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-2 h-3.5 w-3.5" />}
          {t("settings.server.save", "Save")}
        </Button>
      </div>
    </div>
  );
}
