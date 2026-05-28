import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAuthStore } from "@/stores/auth-store";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function UpgradeAccountDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const {
    sendUpgradeEmailOtp,
    verifyUpgradeEmailOtp,
    resetUpgradeOtp,
    upgradeEmail,
    loading,
    errorMessage,
  } = useAuthStore();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");

  useEffect(() => {
    if (!open) {
      setEmail("");
      setCode("");
      resetUpgradeOtp();
    }
  }, [open, resetUpgradeOtp]);

  const onSendEmail = async (event: React.FormEvent) => {
    event.preventDefault();
    await sendUpgradeEmailOtp(email);
  };

  const onVerify = async (event: React.FormEvent) => {
    event.preventDefault();
    const ok = await verifyUpgradeEmailOtp(code);
    if (ok) onOpenChange(false);
  };

  const onUseDifferentEmail = () => {
    setCode("");
    resetUpgradeOtp();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{t("auth.upgrade.title", "Upgrade your account")}</DialogTitle>
          <DialogDescription>
            {t(
              "auth.upgrade.desc",
              "Bind an email so you don't lose access to this workspace.",
            )}
          </DialogDescription>
        </DialogHeader>

        {!upgradeEmail ? (
          <form onSubmit={onSendEmail} className="space-y-4">
            <label className="space-y-2 block">
              <span className="text-[12px] font-medium text-ink-2">
                {t("auth.email", "Email")}
              </span>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
                placeholder="you@example.com"
              />
            </label>
            {errorMessage && (
              <p className="text-[12px] text-destructive">{errorMessage}</p>
            )}
            <Button
              type="submit"
              disabled={loading || !email.trim()}
              className="h-10 w-full bg-coral text-paper hover:bg-coral/90"
            >
              {loading
                ? t("auth.upgrade.sending", "Sending…")
                : t("auth.upgrade.sendCode", "Send code")}
            </Button>
          </form>
        ) : (
          <form onSubmit={onVerify} className="space-y-4">
            <p className="text-[12px] text-muted-foreground">
              {t("auth.upgrade.codeSentTo", "We sent a 6-digit code to")}{" "}
              <span className="font-mono text-foreground">{upgradeEmail}</span>
            </p>
            <label className="space-y-2 block">
              <span className="text-[12px] font-medium text-ink-2">
                {t("auth.verifyCode", "Verification code")}
              </span>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoFocus
                className="font-mono"
              />
            </label>
            {errorMessage && (
              <p className="text-[12px] text-destructive">{errorMessage}</p>
            )}
            <Button
              type="submit"
              disabled={loading || !code.trim()}
              className="h-10 w-full bg-coral text-paper hover:bg-coral/90"
            >
              {loading
                ? t("auth.upgrade.verifying", "Verifying…")
                : t("auth.upgrade.confirm", "Confirm and upgrade")}
            </Button>
            <button
              type="button"
              onClick={onUseDifferentEmail}
              className="block w-full text-center text-[12px] text-muted-foreground hover:text-foreground"
            >
              {t("auth.useDifferentEmail", "Use a different email")}
            </button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
