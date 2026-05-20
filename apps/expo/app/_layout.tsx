import "../src/lib/polyfills";

import { Slot } from "expo-router";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ToastHost } from "../src/ui/Toast";
import { createOnboardingController } from "../src/features/onboarding/onboarding-store";
import type {
  OnboardingRoute,
  OnboardingState,
} from "../src/features/onboarding/onboarding-types";
import { createOnboardingApi } from "../src/lib/supabase/onboarding-api";
import { supabase } from "../src/lib/supabase/client";
import { colors } from "../src/ui/theme";

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

  const value: OnboardingContextValue = {
    controller,
    state,
    retryBootstrap: async () => {
      await controller.bootstrap();
    },
  };

  return (
    <OnboardingContext.Provider value={value}>
      {children}
    </OnboardingContext.Provider>
  );
}

export default function RootLayout() {
  return (
    <OnboardingProvider>
      <SafeAreaView edges={["top", "bottom"]} style={styles.safeArea}>
        <View style={styles.layout}>
          <Slot />
          <ToastHost />
        </View>
      </SafeAreaView>
    </OnboardingProvider>
  );
}

const styles = StyleSheet.create({
  layout: {
    backgroundColor: colors.background,
    flex: 1,
  },
  safeArea: {
    backgroundColor: colors.background,
    flex: 1,
  },
});
