import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";

import { useOnboarding } from "../_layout";
import { createActorsApi } from "../../src/features/actors/actor-api";
import type { Actor } from "../../src/features/actors/actor-types";
import { ActorDetailScreen } from "../../src/features/actors/screens/ActorDetailScreen";
import { supabase } from "../../src/lib/supabase/client";

export default function ActorDetailRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const params = useLocalSearchParams<{ actorId?: string }>();
  const actorId = typeof params.actorId === "string" ? params.actorId : null;
  const teamId = state.currentTeam?.id ?? "";
  const isMe = actorId !== null && actorId === state.currentMemberActorId;

  const [actor, setActor] = useState<Actor | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!teamId || !actorId) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    void createActorsApi(supabase)
      .listActors(teamId)
      .then((rows) => {
        if (cancelled) return;
        setActor(rows.find((row) => row.actorId === actorId) ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setActor(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [actorId, teamId]);

  return (
    <ActorDetailScreen
      actor={actor}
      isLoading={isLoading}
      isMe={isMe}
      onClose={() => router.back()}
    />
  );
}
