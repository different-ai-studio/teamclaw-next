import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";

import { useOnboarding } from "../_layout";
import { SettingsScreen } from "../../src/features/settings/screens/SettingsScreen";
import { supabase } from "../../src/lib/supabase/client";

export default function SettingsRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void supabase.auth.getUser().then(({ data }) => {
      if (cancelled) return;
      setUserEmail(data.user?.email ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const displayName =
    userEmail?.split("@")[0] ?? (state.isAnonymous ? "Guest" : "You");
  const appVersion = (Constants.expoConfig?.version as string | undefined) ?? "—";
  const buildNumber =
    (Constants.expoConfig?.runtimeVersion as string | undefined) ?? "—";

  const handleSignOut = async () => {
    setIsSigningOut(true);
    await supabase.auth.signOut();
    setIsSigningOut(false);
    router.replace("/");
  };

  return (
    <SettingsScreen
      appVersion={appVersion}
      buildNumber={buildNumber}
      displayName={displayName}
      isSigningOut={isSigningOut}
      onClose={() => router.back()}
      onSignOut={handleSignOut}
      team={
        state.currentTeam
          ? { name: state.currentTeam.name, role: state.currentTeam.role ?? null }
          : null
      }
      userEmail={userEmail}
    />
  );
}
