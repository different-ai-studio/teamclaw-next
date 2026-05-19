import { Redirect, useRouter } from "expo-router";
import { useEffect, useRef, useSyncExternalStore } from "react";

import { routeToHref, useOnboarding } from "../../../_layout";
import { createSessionsApi } from "../../../../src/features/sessions/session-api";
import { createSessionsController } from "../../../../src/features/sessions/session-controller";
import { SessionsListScreen } from "../../../../src/features/sessions/screens/SessionsListScreen";
import { supabase } from "../../../../src/lib/supabase/client";

export default function SessionsIndexRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const href = routeToHref(state.route);
  const controllerRef = useRef<ReturnType<typeof createSessionsController> | null>(null);
  const teamIdRef = useRef<string | null>(null);
  const activeTeamId = state.currentTeam?.id ?? "";

  if (controllerRef.current === null || teamIdRef.current !== activeTeamId) {
    controllerRef.current = createSessionsController(
      createSessionsApi(supabase),
      activeTeamId,
    );
    teamIdRef.current = activeTeamId;
  }

  const controller = controllerRef.current;
  const listState = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );

  useEffect(() => {
    if (!activeTeamId) {
      return;
    }

    void controller.load();
  }, [activeTeamId, controller]);

  if (state.route !== "ready") {
    return <Redirect href={href ?? "/"} />;
  }

  if (state.currentTeam === null) {
    return <Redirect href="/" />;
  }

  return (
    <SessionsListScreen
      onLoad={() => {
        void controller.load();
      }}
      onNewSession={() => {
        router.push("/(app)/sessions/new");
      }}
      onRefresh={() => {
        void controller.refresh();
      }}
      onSelectSession={(sessionId) => {
        router.push(`/(app)/sessions/${sessionId}`);
      }}
      state={listState}
    />
  );
}
