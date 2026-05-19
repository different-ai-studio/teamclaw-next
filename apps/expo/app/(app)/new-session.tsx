import { useRouter } from "expo-router";
import { useState } from "react";

import { useOnboarding } from "../_layout";
import { createActorsApi } from "../../src/features/actors/actor-api";
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
  const { state } = useOnboarding();
  const [isBusy, setIsBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  return (
    <NewSessionScreen
      errorMessage={errorMessage}
      isBusy={isBusy}
      onClose={() => router.back()}
      onCreate={async ({ firstMessage }) => {
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
          const actorsApi = createActorsApi(supabase);
          const actors = await actorsApi.listActors(state.currentTeam.id);
          const primaryAgent = actors.find((actor) => actor.actorType === "agent");

          const sessionId = await sessionsApi.createSession({
            title: deriveTitle(firstMessage),
            mode: "agent",
            primaryAgentId: primaryAgent?.actorId ?? null,
          });

          if (firstMessage.trim().length > 0) {
            await sessionsApi.insertOutgoingMessage({
              id: uuidV4(),
              teamId: state.currentTeam.id,
              sessionId,
              senderActorId: memberActorId,
              content: firstMessage.trim(),
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
