import "../src/lib/polyfills";

import * as Linking from "expo-linking";
import { Slot } from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ToastHost, showToast } from "../src/ui/Toast";
import { createInviteApi, parseInviteToken } from "../src/features/onboarding/invite-api";
import { createOnboardingController } from "../src/features/onboarding/onboarding-store";
import type {
  OnboardingRoute,
  OnboardingState,
} from "../src/features/onboarding/onboarding-types";
import {
  clearPendingInviteToken,
  loadPendingInviteToken,
  savePendingInviteToken,
} from "../src/features/onboarding/pending-invite";
import { createOnboardingApi } from "../src/lib/supabase/onboarding-api";
import { supabase } from "../src/lib/supabase/client";
import { colors } from "../src/ui/theme";
import { createTeamMqttClient, type TeamMqttClient } from "../src/lib/mqtt/team-mqtt";
import { getOptionalMqttUrl } from "../src/lib/mqtt/config";
import { createAgentAccessApi } from "../src/features/actors/agent-access-api";
import { createRuntimeStateSubscriber } from "../src/features/actors/runtime-state-subscriber";
import {
  createConnectedAgentsStore,
  type ConnectedAgentsStore,
} from "../src/features/actors/connected-agents-store";
import { createConnectedAgentsCache } from "../src/features/actors/connected-agents-cache";
import { getDb } from "../src/lib/db/sqlite";
import { decodeRuntimeInfo } from "../src/lib/teamclaw/runtime-info";

const onboardingApi = createOnboardingApi(supabase);

type OnboardingController = ReturnType<typeof createOnboardingController>;

type OnboardingContextValue = {
  controller: OnboardingController;
  state: OnboardingState;
  retryBootstrap: () => Promise<void>;
};

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

export function useOnboarding() {
  const context = useContext(OnboardingContext);

  if (!context) {
    throw new Error("useOnboarding must be used inside RootLayout");
  }

  return context;
}

export const TeamMqttContext = createContext<TeamMqttClient | null>(null);

export function useTeamMqtt(): TeamMqttClient | null {
  return useContext(TeamMqttContext);
}

export function routeToHref(route: OnboardingRoute): string | null {
  switch (route) {
    case "needsAuth":
      return "/welcome";
    case "createTeam":
      return "/create-team";
    case "ready":
      return "/(app)/sessions";
    case "loading":
    case "failed":
      return null;
  }
}

function OnboardingProvider({ children }: { children: ReactNode }) {
  const [controller] = useState(() => createOnboardingController(onboardingApi));
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  const lastClaimedTokenRef = useRef<string | null>(null);
  const teamMqttRef = useRef<TeamMqttClient | null>(null);
  const connectedAgentsStoreRef = useRef<ConnectedAgentsStore | null>(null);
  const [teamMqtt, setTeamMqtt] = useState<TeamMqttClient | null>(null);

  useEffect(() => {
    void controller.bootstrap().catch(() => {
      // Error state is stored inside the controller for the routes to render.
    });
  }, [controller]);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange(() => {
      void controller.bootstrap().catch(() => {
        // Keep the controller state as the source of truth for auth/bootstrap failures.
      });
    });

    return () => {
      data.subscription.unsubscribe();
    };
  }, [controller]);

  // Mirrors iOS `AppOnboardingCoordinator` invite token replay. Any
  // `teamclaw://invite/<token>` link — whether the OS hands it to us on
  // cold start or while the app is foregrounded — is stashed for later
  // replay; the route `ready` effect below redeems it once we know the
  // user is signed in.
  useEffect(() => {
    const handleUrl = (url: string | null | undefined) => {
      const token = parseInviteToken(url);
      if (!token) return;
      void savePendingInviteToken(token).then(() => {
        void controller.bootstrap();
      });
    };
    void Linking.getInitialURL().then(handleUrl);
    const subscription = Linking.addEventListener("url", (event) => {
      handleUrl(event.url);
    });
    return () => {
      subscription.remove();
    };
  }, [controller]);

  useEffect(() => {
    if (state.route !== "ready") return;
    let cancelled = false;
    void (async () => {
      const token = await loadPendingInviteToken();
      if (!token || cancelled) return;
      if (token === lastClaimedTokenRef.current) return;
      lastClaimedTokenRef.current = token;
      try {
        const result = await createInviteApi(supabase).claim(token);
        if (cancelled) return;
        showToast(
          "success",
          result.displayName
            ? `Joined as ${result.displayName}`
            : "Joined team via invite",
        );
        await controller.bootstrap();
      } catch (err) {
        if (cancelled) return;
        showToast(
          "error",
          err instanceof Error ? err.message : "Couldn't redeem invite link.",
        );
      } finally {
        await clearPendingInviteToken();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [controller, state.route]);

  // Wire up team-scoped MQTT + ConnectedAgentsStore when the user is ready.
  // Tears down and recreates automatically when the team or actor changes.
  useEffect(() => {
    if (state.route !== "ready") return;
    if (!state.currentTeam || !state.currentMemberActorId) return;

    const mqttUrl = getOptionalMqttUrl();
    if (!mqttUrl) return;

    let disposed = false;

    void (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token ?? null;
      if (!accessToken || disposed) return;

      const mqtt = createTeamMqttClient({
        url: mqttUrl,
        username: state.currentMemberActorId!,
        password: accessToken,
        clientId: `teamclaw-expo-${state.currentMemberActorId!.slice(0, 8)}`,
      });
      try {
        await mqtt.start();
      } catch {
        return;
      }
      if (disposed) {
        void mqtt.dispose();
        return;
      }
      teamMqttRef.current = mqtt;
      setTeamMqtt(mqtt);

      const db = await getDb();
      const cache = createConnectedAgentsCache(db as Parameters<typeof createConnectedAgentsCache>[0]);
      const subscriber = createRuntimeStateSubscriber({
        mqtt,
        teamId: state.currentTeam!.id,
        decode: decodeRuntimeInfo,
        onRuntimeInfo: (deviceId, runtimeId, info) =>
          connectedAgentsStoreRef.current?.handleRuntimeInfo(deviceId, runtimeId, info),
      });
      const store = createConnectedAgentsStore({
        teamId: state.currentTeam!.id,
        api: createAgentAccessApi(supabase),
        subscriber,
        cache,
      });
      connectedAgentsStoreRef.current = store;
      if (disposed) {
        void store.dispose();
        void mqtt.dispose();
        teamMqttRef.current = null;
        connectedAgentsStoreRef.current = null;
        return;
      }
      await store.reload();
    })();

    return () => {
      disposed = true;
      void connectedAgentsStoreRef.current?.dispose();
      void teamMqttRef.current?.dispose();
      connectedAgentsStoreRef.current = null;
      teamMqttRef.current = null;
      setTeamMqtt(null);
    };
  }, [state.route, state.currentTeam?.id, state.currentMemberActorId]);

  const value: OnboardingContextValue = {
    controller,
    state,
    retryBootstrap: async () => {
      await controller.bootstrap();
    },
  };

  return (
    <OnboardingContext.Provider value={value}>
      <TeamMqttContext.Provider value={teamMqtt}>
        {children}
      </TeamMqttContext.Provider>
    </OnboardingContext.Provider>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <OnboardingProvider>
        <SafeAreaView edges={["top", "bottom"]} style={styles.safeArea}>
          <View style={styles.layout}>
            <Slot />
            <ToastHost />
          </View>
        </SafeAreaView>
      </OnboardingProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  layout: {
    backgroundColor: colors.background,
    flex: 1,
  },
  safeArea: {
    backgroundColor: colors.background,
    flex: 1,
  },
});
