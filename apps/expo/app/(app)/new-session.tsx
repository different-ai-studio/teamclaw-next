import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";

import { useOnboarding } from "../_layout";
import { createActorsApi } from "../../src/features/actors/actor-api";
import type { Actor } from "../../src/features/actors/actor-types";
import { createIdeasApi } from "../../src/features/ideas/idea-api";
import { isOpenIdea, type Idea } from "../../src/features/ideas/idea-types";
import { buildFirstMessageWithIdea } from "../../src/features/sessions/idea-preface";
import { createSessionsApi } from "../../src/features/sessions/session-api";
import { NewSessionScreen } from "../../src/features/sessions/screens/NewSessionScreen";
import { supabase } from "../../src/lib/supabase/client";
import { uuidV4 } from "../../src/lib/uuid";

function deriveTitle(firstMessage: string): string {
  const trimmed = firstMessage.trim();
  if (!trimmed) return "New session";
  const firstLine = trimmed.split(/\n/)[0] ?? trimmed;
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

export default function NewSessionRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ ideaId?: string }>();
  const ideaId = typeof params.ideaId === "string" ? params.ideaId : null;
  const { state } = useOnboarding();
  const [isBusy, setIsBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actors, setActors] = useState<Actor[]>([]);
  const [ideas, setIdeas] = useState<Idea[]>([]);

  useEffect(() => {
    const teamId = state.currentTeam?.id;
    if (!teamId) return;
    let cancelled = false;
    void Promise.all([
      createActorsApi(supabase).listActors(teamId),
      createIdeasApi(supabase).listIdeas(teamId),
    ])
      .then(([actorRows, ideaRows]) => {
        if (cancelled) return;
        setActors(actorRows);
        setIdeas(ideaRows.filter(isOpenIdea));
      })
      .catch(() => {
        if (cancelled) return;
        setActors([]);
        setIdeas([]);
      });
    return () => {
      cancelled = true;
    };
  }, [state.currentTeam?.id]);

  const ideaChoices = useMemo(
    () =>
      ideas.map((idea) => ({
        ideaId: idea.ideaId,
        displayTitle: idea.title.trim() || "Untitled idea",
      })),
    [ideas],
  );

  return (
    <NewSessionScreen
      actors={actors}
      currentMemberActorId={state.currentMemberActorId}
      errorMessage={errorMessage}
      ideas={ideaChoices}
      isBusy={isBusy}
      selectedIdeaId={ideaId}
      onClose={() => router.back()}
      onCreate={async ({
        firstMessage,
        collaboratorActorIds,
        primaryAgentActorId,
        ideaId: chosenIdeaId,
      }) => {
        if (!state.currentTeam) {
          setErrorMessage("No active team — bootstrap first.");
          return;
        }
        const memberActorId = state.currentMemberActorId;
        if (!memberActorId) {
          setErrorMessage("Couldn't resolve your member identity in this team.");
          return;
        }

        setIsBusy(true);
        setErrorMessage(null);
        try {
          const sessionsApi = createSessionsApi(supabase);
          const idea = chosenIdeaId
            ? ideas.find((row) => row.ideaId === chosenIdeaId)
            : undefined;
          const expandedMessage = buildFirstMessageWithIdea(firstMessage, idea);
          const sessionId = await sessionsApi.createSession({
            title: deriveTitle(firstMessage),
            mode: "collab",
            primaryAgentId: primaryAgentActorId,
            ideaId: chosenIdeaId,
          });

          // create_session seeds session_participants with the caller and the
          // primary agent. Add any other picked collaborators (extra agents,
          // humans) on top.
          const extras = collaboratorActorIds.filter(
            (id) => id !== primaryAgentActorId && id !== memberActorId,
          );
          if (extras.length > 0) {
            await sessionsApi.addParticipants(sessionId, extras);
          }

          if (expandedMessage.trim().length > 0) {
            await sessionsApi.insertOutgoingMessage({
              id: uuidV4(),
              teamId: state.currentTeam.id,
              sessionId,
              senderActorId: memberActorId,
              content: expandedMessage.trim(),
              metadata: { mention_actor_ids: [] },
            });
          }

          router.replace(`/(app)/sessions/${sessionId}`);
        } catch (error) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Couldn't create the session — try again.",
          );
        } finally {
          setIsBusy(false);
        }
      }}
    />
  );
}
