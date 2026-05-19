import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";

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
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [recentSessions, setRecentSessions] = useState<RecentSession[]>([]);
  const [stats, setStats] = useState<{ sessions: number; ideas: number } | null>(null);

  const refresh = useCallback(async () => {
    if (!teamId || !actorId) return;
    setIsRefreshing(true);
    try {
      const rows = await createActorsApi(supabase).listActors(teamId);
      setActor(rows.find((row) => row.actorId === actorId) ?? null);
    } finally {
      setIsRefreshing(false);
    }
  }, [actorId, teamId]);

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

        const [sessionsCount, ideasCount] = await Promise.all([
          supabase
            .from("session_participants")
            .select("session_id", { count: "exact", head: true })
            .eq("actor_id", actorId),
          supabase
            .from("ideas")
            .select("id", { count: "exact", head: true })
            .eq("created_by_actor_id", actorId)
            .eq("archived", false),
        ]);
        if (cancelled) return;
        setStats({
          sessions: sessionsCount.count ?? 0,
          ideas: ideasCount.count ?? 0,
        });
      } catch {
        if (!cancelled) {
          setActor(null);
          setRecentSessions([]);
          setStats(null);
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
      isRefreshing={isRefreshing}
      onClose={() => router.back()}
      onRefresh={() => {
        void refresh();
      }}
      onSelectSession={(sessionId) => {
        router.replace(`/(app)/sessions/${sessionId}`);
      }}
      recentSessions={recentSessions}
      stats={stats ?? undefined}
    />
  );
}
