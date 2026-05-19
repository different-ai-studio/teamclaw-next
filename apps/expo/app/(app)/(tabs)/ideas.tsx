import { Redirect, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { routeToHref, useOnboarding } from "../../_layout";
import { createIdeasApi } from "../../../src/features/ideas/idea-api";
import { createIdeasController } from "../../../src/features/ideas/idea-controller";
import { IdeasListScreen } from "../../../src/features/ideas/screens/IdeasListScreen";
import { supabase } from "../../../src/lib/supabase/client";

export default function IdeasIndexRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const href = routeToHref(state.route);
  const teamId = state.currentTeam?.id ?? "";
  const controllerRef = useRef<ReturnType<typeof createIdeasController> | null>(null);
  const teamIdRef = useRef<string | null>(null);

  if (controllerRef.current === null || teamIdRef.current !== teamId) {
    controllerRef.current = createIdeasController(createIdeasApi(supabase), teamId);
    teamIdRef.current = teamId;
  }

  const controller = controllerRef.current;
  const listState = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );

  useEffect(() => {
    if (!teamId) return;
    void controller.load();
  }, [controller, teamId]);

  useFocusEffect(
    useCallback(() => {
      if (!teamId) return;
      void controller.refresh();
    }, [controller, teamId]),
  );

  if (state.route !== "ready") {
    return <Redirect href={href ?? "/"} />;
  }

  if (state.currentTeam === null) {
    return <Redirect href="/" />;
  }

  return (
    <IdeasListScreen
      currentActorId={state.currentMemberActorId}
      onCreate={() => router.push("/(app)/new-idea")}
      onOpenArchived={() => router.push("/(app)/archived-ideas")}
      onArchiveBatch={async (ideaIds) => {
        const api = createIdeasApi(supabase);
        for (const id of ideaIds) {
          try {
            await api.archive(id);
          } catch {
            // Continue archiving the rest; controller refresh picks up the partial diff.
          }
        }
        await controller.refresh();
      }}
      onLoad={() => {
        void controller.load();
      }}
      onRefresh={() => {
        void controller.refresh();
      }}
      onSelectIdea={(ideaId) => {
        router.push(`/(app)/idea-detail?ideaId=${ideaId}`);
      }}
      state={listState}
    />
  );
}
