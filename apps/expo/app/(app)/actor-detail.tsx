import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";

import { useOnboarding } from "../_layout";
import { createActorsApi } from "../../src/features/actors/actor-api";
import type { Actor } from "../../src/features/actors/actor-types";
import { ActorDetailScreen } from "../../src/features/actors/screens/ActorDetailScreen";
import { supabase } from "../../src/lib/supabase/client";

type RecentSession = {
  sessionId: string;
  title: string;
  lastMessageAt: string;
};

export default function ActorDetailRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const params = useLocalSearchParams<{ actorId?: string }>();
  const actorId = typeof params.actorId === "string" ? params.actorId : null;
  const teamId = state.currentTeam?.id ?? "";
  const isMe = actorId !== null && actorId === state.currentMemberActorId;

  const [actor, setActor] = useState<Actor | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [recentSessions, setRecentSessions] = useState<RecentSession[]>([]);

  useEffect(() => {
    if (!teamId || !actorId) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    void (async () => {
      try {
        const rows = await createActorsApi(supabase).listActors(teamId);
        if (cancelled) return;
        setActor(rows.find((row) => row.actorId === actorId) ?? null);

        const participants = (await supabase
          .from("session_participants")
          .select("session_id, sessions:session_id(id, title, last_message_at)")
          .eq("actor_id", actorId)
          .limit(8)) as {
          data:
            | Array<{
                session_id: string;
                sessions:
                  | { id: string; title: string | null; last_message_at: string | null }
                  | null;
              }>
            | null;
          error: { message?: string } | null;
        };
        if (cancelled) return;
        const sessions = (participants.data ?? [])
          .map((row) => row.sessions)
          .filter(
            (s): s is { id: string; title: string | null; last_message_at: string | null } =>
              Boolean(s),
          )
          .map((s) => ({
            sessionId: s.id,
            title: s.title ?? "",
            lastMessageAt: s.last_message_at ?? "",
          }))
          .sort((a, b) => {
            const ams = Date.parse(a.lastMessageAt) || 0;
            const bms = Date.parse(b.lastMessageAt) || 0;
            return bms - ams;
          })
          .slice(0, 5);
        setRecentSessions(sessions);
      } catch {
        if (!cancelled) {
          setActor(null);
          setRecentSessions([]);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
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
      onSelectSession={(sessionId) => {
        router.replace(`/(app)/sessions/${sessionId}`);
      }}
      recentSessions={recentSessions}
    />
  );
}
