import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";

import { useOnboarding } from "../_layout";
import { createActorsApi } from "../../src/features/actors/actor-api";
import { createIdeasApi } from "../../src/features/ideas/idea-api";
import type { Idea } from "../../src/features/ideas/idea-types";
import { IdeaDetailScreen } from "../../src/features/ideas/screens/IdeaDetailScreen";
import { supabase } from "../../src/lib/supabase/client";

export default function IdeaDetailRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const params = useLocalSearchParams<{ ideaId?: string }>();
  const ideaId = typeof params.ideaId === "string" ? params.ideaId : null;
  const teamId = state.currentTeam?.id ?? "";

  const [idea, setIdea] = useState<Idea | null>(null);
  const [creatorName, setCreatorName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!teamId || !ideaId) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    void (async () => {
      try {
        const ideasApi = createIdeasApi(supabase);
        const actorsApi = createActorsApi(supabase);
        const [ideas, actors] = await Promise.all([
          ideasApi.listIdeas(teamId),
          actorsApi.listActors(teamId),
        ]);
        if (cancelled) return;
        const found = ideas.find((row) => row.ideaId === ideaId) ?? null;
        setIdea(found);
        if (found?.createdByActorId) {
          const creator = actors.find((row) => row.actorId === found.createdByActorId);
          setCreatorName(creator?.displayName ?? null);
        } else {
          setCreatorName(null);
        }
      } catch {
        if (cancelled) return;
        setIdea(null);
        setCreatorName(null);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ideaId, teamId]);

  return (
    <IdeaDetailScreen
      creatorName={creatorName}
      idea={idea}
      isLoading={isLoading}
      onClose={() => router.back()}
    />
  );
}
