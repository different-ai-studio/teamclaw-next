import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";

import { useOnboarding } from "../_layout";
import { createActorsApi } from "../../src/features/actors/actor-api";
import type { Actor } from "../../src/features/actors/actor-types";
import { createSessionsApi } from "../../src/features/sessions/session-api";
import { SessionMemberSheet } from "../../src/features/sessions/screens/SessionMemberSheet";
import { supabase } from "../../src/lib/supabase/client";
import { showToast } from "../../src/ui/Toast";

export default function SessionMembersRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const params = useLocalSearchParams<{ sessionId?: string }>();
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
  const teamId = state.currentTeam?.id ?? "";

  const [actors, setActors] = useState<Actor[]>([]);
  const [participantIds, setParticipantIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!teamId || !sessionId) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    const sessionsApi = createSessionsApi(supabase);
    const actorsApi = createActorsApi(supabase);
    void Promise.all([sessionsApi.getSession(teamId, sessionId), actorsApi.listActors(teamId)])
      .then(([session, allActors]) => {
        if (cancelled) return;
        setParticipantIds(session?.participantActorIds ?? []);
        setActors(allActors);
      })
      .catch(() => {
        if (cancelled) return;
        setActors([]);
        setParticipantIds([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, teamId]);

  const participants = useMemo(() => {
    if (participantIds.length === 0) return actors;
    const ids = new Set(participantIds);
    return actors.filter((actor) => ids.has(actor.actorId));
  }, [actors, participantIds]);

  const handleRemove = async (actorId: string) => {
    if (!sessionId) return;
    try {
      await createSessionsApi(supabase).removeParticipant(sessionId, actorId);
      setParticipantIds((prev) => prev.filter((id) => id !== actorId));
      showToast("success", "Removed from session");
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Couldn't remove participant",
      );
    }
  };

  return (
    <SessionMemberSheet
      actors={participants}
      currentActorId={state.currentMemberActorId ?? null}
      isLoading={isLoading}
      onAddAgent={() => router.push("/(app)/invite")}
      onAddMember={() => router.push("/(app)/invite")}
      onClose={() => router.back()}
      onRemoveActor={handleRemove}
    />
  );
}
