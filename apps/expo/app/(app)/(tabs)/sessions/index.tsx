import { Redirect, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { routeToHref, useOnboarding } from "../../../_layout";
import {
  loadPinnedSessions,
  subscribePinnedSessions,
  togglePinnedSession,
} from "../../../../src/features/sessions/pinned-sessions";
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
      state.currentMemberActorId,
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

  useFocusEffect(
    useCallback(() => {
      if (!activeTeamId) return;
      void controller.refresh();
    }, [activeTeamId, controller]),
  );

  const [pinnedSessionIds, setPinnedSessionIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  useEffect(() => {
    let cancelled = false;
    void loadPinnedSessions().then((set) => {
      if (!cancelled) setPinnedSessionIds(set);
    });
    const unsubscribe = subscribePinnedSessions((next) => {
      if (!cancelled) setPinnedSessionIds(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  if (state.route !== "ready") {
    return <Redirect href={href ?? "/"} />;
  }

  if (state.currentTeam === null) {
    return <Redirect href="/" />;
  }

  return (
    <SessionsListScreen
      onArchiveBatch={async (sessionIds) => {
        const now = new Date().toISOString();
        for (const id of sessionIds) {
          try {
            await supabase
              .from("sessions")
              .update({ archived_at: now })
              .eq("id", id);
          } catch {
            // continue
          }
        }
        await controller.refresh();
      }}
      onLoad={() => {
        void controller.load();
      }}
      onMarkBatchRead={async (sessionIds) => {
        const actorId = state.currentMemberActorId;
        if (!actorId) return;
        const api = createSessionsApi(supabase);
        for (const id of sessionIds) {
          try {
            await api.markSessionRead(id, actorId, null);
          } catch {
            // continue
          }
        }
        await controller.refresh();
      }}
      onNewSession={() => {
        router.push("/(app)/new-session");
      }}
      onTogglePin={async (sessionId) => {
        await togglePinnedSession(sessionId);
      }}
      pinnedSessionIds={pinnedSessionIds}
      onRefresh={() => {
        void controller.refresh();
      }}
      onSelectSession={(sessionId) => {
        router.push(`/(app)/sessions/${sessionId}`);
      }}
      onShortcuts={() => {
        router.push("/(app)/shortcuts");
      }}
      state={listState}
    />
  );
}
