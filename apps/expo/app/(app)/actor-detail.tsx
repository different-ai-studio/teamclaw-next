import { useLocalSearchParams, useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useState } from "react";
import { Alert, Share } from "react-native";

import { useOnboarding, useTeamMqtt } from "../_layout";
import { createActorsApi } from "../../src/features/actors/actor-api";
import { createAgentAccessApi } from "../../src/features/actors/agent-access-api";
import {
  canManageAuthorizedHumans,
  canRemoveActor,
} from "../../src/features/actors/actor-management";
import type { Actor } from "../../src/features/actors/actor-types";
import type { AgentAuthorizedHuman } from "../../src/features/actors/connected-agent-types";
import {
  ActorDetailScreen,
  type AgentWorkspaceChoice,
} from "../../src/features/actors/screens/ActorDetailScreen";
import { supabase } from "../../src/lib/supabase/client";
import { createRuntimeRpcClient } from "../../src/lib/teamclaw/runtime-rpc";
import { showToast } from "../../src/ui/Toast";

type RecentSession = {
  sessionId: string;
  title: string;
  lastMessageAt: string;
};

export default function ActorDetailRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const teamMqtt = useTeamMqtt();
  const params = useLocalSearchParams<{ actorId?: string }>();
  const actorId = typeof params.actorId === "string" ? params.actorId : null;
  const teamId = state.currentTeam?.id ?? "";
  const isMe = actorId !== null && actorId === state.currentMemberActorId;

  const [actor, setActor] = useState<Actor | null>(null);
  const [allActors, setAllActors] = useState<Actor[]>([]);
  const [agentWorkspaces, setAgentWorkspaces] = useState<AgentWorkspaceChoice[]>([]);
  const [authorizedHumans, setAuthorizedHumans] = useState<AgentAuthorizedHuman[]>([]);
  const [isCreatingReinvite, setIsCreatingReinvite] = useState(false);
  const [isAddingAgentWorkspace, setIsAddingAgentWorkspace] = useState(false);
  const [isGrantingAuthorizedHuman, setIsGrantingAuthorizedHuman] = useState(false);
  const [isLoadingAuthorizedHumans, setIsLoadingAuthorizedHumans] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [isRevokingAuthorizedHuman, setIsRevokingAuthorizedHuman] = useState(false);
  const [isRemovingAgentWorkspace, setIsRemovingAgentWorkspace] = useState(false);
  const [isSavingAgentDefaults, setIsSavingAgentDefaults] = useState(false);
  const [isUpdatingAgentVisibility, setIsUpdatingAgentVisibility] = useState(false);
  const [recentSessions, setRecentSessions] = useState<RecentSession[]>([]);
  const [stats, setStats] = useState<{ sessions: number; ideas: number } | null>(null);
  const canRemove = canRemoveActor({
    actorId,
    currentMemberActorId: state.currentMemberActorId,
    currentTeamRole: state.currentTeam?.role,
  });
  const canManageAccess = canManageAuthorizedHumans({
    actorType: actor?.actorType,
    ownerMemberId: actor?.ownerMemberId,
    currentMemberActorId: state.currentMemberActorId,
  });
  const authorizedHumanIds = new Set(authorizedHumans.map((human) => human.id));
  const authorizedMemberCandidates = allActors.filter(
    (row) =>
      row.actorType === "member" &&
      row.actorId !== state.currentMemberActorId &&
      !authorizedHumanIds.has(row.actorId),
  );

  const reloadAgentWorkspaces = useCallback(async () => {
    if (!teamId) return;
    const result = await supabase
      .from("workspaces")
      .select("id, name, path, agent_id, archived")
      .eq("team_id", teamId)
      .eq("archived", false)
      .order("name", { ascending: true });
    if (result.error) {
      setAgentWorkspaces([]);
      return;
    }
    setAgentWorkspaces(
      ((result.data ?? []) as Array<{
        id: string;
        name: string | null;
        path: string | null;
        agent_id: string | null;
      }>).map((row) => ({
        id: row.id,
        name: row.name ?? "",
        path: row.path ?? null,
        agentId: row.agent_id ?? null,
      })),
    );
  }, [teamId]);

  const refresh = useCallback(async () => {
    if (!teamId || !actorId) return;
    setIsRefreshing(true);
    try {
      const rows = await createActorsApi(supabase).listActors(teamId);
      setAllActors(rows);
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
        const nextActor = rows.find((row) => row.actorId === actorId) ?? null;
        setAllActors(rows);
        setActor(nextActor);

        if (nextActor?.actorType === "agent") {
          setIsLoadingAuthorizedHumans(true);
          const [authorizedRows, workspaceResult] = await Promise.all([
            createAgentAccessApi(supabase).listAuthorizedHumans(actorId),
            supabase
              .from("workspaces")
              .select("id, name, path, agent_id, archived")
              .eq("team_id", teamId)
              .eq("archived", false)
              .order("name", { ascending: true }),
          ]);
          if (cancelled) return;
          setAuthorizedHumans(authorizedRows);
          if (workspaceResult.error) {
            setAgentWorkspaces([]);
          } else {
            setAgentWorkspaces(
              ((workspaceResult.data ?? []) as Array<{
                id: string;
                name: string | null;
                path: string | null;
                agent_id: string | null;
              }>).map((row) => ({
                id: row.id,
                name: row.name ?? "",
                path: row.path ?? null,
                agentId: row.agent_id ?? null,
              })),
            );
          }
          setIsLoadingAuthorizedHumans(false);
        } else {
          setAuthorizedHumans([]);
          setAgentWorkspaces([]);
        }

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
          setAllActors([]);
          setAgentWorkspaces([]);
          setAuthorizedHumans([]);
          setRecentSessions([]);
          setStats(null);
        }
      } finally {
        if (!cancelled) setIsLoadingAuthorizedHumans(false);
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actorId, teamId]);

  const reloadAuthorizedHumans = useCallback(async () => {
    if (!actorId || actor?.actorType !== "agent") return;
    setIsLoadingAuthorizedHumans(true);
    try {
      const rows = await createAgentAccessApi(supabase).listAuthorizedHumans(actorId);
      setAuthorizedHumans(rows);
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Couldn't load authorized members.",
      );
    } finally {
      setIsLoadingAuthorizedHumans(false);
    }
  }, [actor?.actorType, actorId]);

  const removeActor = useCallback(() => {
    if (!actorId || !actor || isRemoving) return;
    Alert.alert(
      "Remove actor",
      `Remove ${actor.displayName} from this team?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            setIsRemoving(true);
            void createActorsApi(supabase)
              .removeActor(actorId)
              .then(() => {
                showToast("success", "Actor removed from team.");
                router.back();
              })
              .catch((err) => {
                showToast(
                  "error",
                  err instanceof Error ? err.message : "Couldn't remove actor.",
                );
              })
              .finally(() => {
                setIsRemoving(false);
              });
          },
        },
      ],
    );
  }, [actor, actorId, isRemoving, router]);

  const createReinvite = useCallback(async () => {
    if (!teamId || !actor || isCreatingReinvite) return;
    setIsCreatingReinvite(true);
    try {
      const invite = await createActorsApi(supabase).createReinvite({ teamId, actor });
      await Clipboard.setStringAsync(invite.deeplink);
      showToast("success", "Invite link copied.");
      await Share.share({ message: invite.deeplink });
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Couldn't create invite link.",
      );
    } finally {
      setIsCreatingReinvite(false);
    }
  }, [actor, isCreatingReinvite, teamId]);

  const grantAuthorizedHuman = useCallback(
    async (memberActorId: string) => {
      if (!actorId || !state.currentMemberActorId || isGrantingAuthorizedHuman) return;
      setIsGrantingAuthorizedHuman(true);
      try {
        await createAgentAccessApi(supabase).grantAuthorizedHuman(
          actorId,
          memberActorId,
          "prompt",
          state.currentMemberActorId,
        );
        showToast("success", "Member authorized.");
        await reloadAuthorizedHumans();
      } catch (err) {
        showToast(
          "error",
          err instanceof Error ? err.message : "Couldn't authorize member.",
        );
      } finally {
        setIsGrantingAuthorizedHuman(false);
      }
    },
    [
      actorId,
      isGrantingAuthorizedHuman,
      reloadAuthorizedHumans,
      state.currentMemberActorId,
    ],
  );

  const revokeAuthorizedHuman = useCallback(
    async (memberActorId: string) => {
      if (!actorId || isRevokingAuthorizedHuman) return;
      setIsRevokingAuthorizedHuman(true);
      try {
        await createAgentAccessApi(supabase).revokeAuthorizedHuman(actorId, memberActorId);
        showToast("success", "Member access revoked.");
        await reloadAuthorizedHumans();
      } catch (err) {
        showToast(
          "error",
          err instanceof Error ? err.message : "Couldn't revoke member access.",
        );
      } finally {
        setIsRevokingAuthorizedHuman(false);
      }
    },
    [actorId, isRevokingAuthorizedHuman, reloadAuthorizedHumans],
  );

  const updateAgentDefaults = useCallback(
    async (patch: { defaultWorkspaceId?: string | null; defaultAgentType?: string | null }) => {
      if (!actorId || !actor || isSavingAgentDefaults) return;
      setIsSavingAgentDefaults(true);
      try {
        await createActorsApi(supabase).updateAgentDefaults(actorId, patch);
        setActor((prev) =>
          prev?.actorId === actorId
            ? {
                ...prev,
                defaultWorkspaceId:
                  patch.defaultWorkspaceId === undefined
                    ? prev.defaultWorkspaceId
                    : patch.defaultWorkspaceId,
                defaultAgentType:
                  patch.defaultAgentType === undefined
                    ? prev.defaultAgentType
                    : patch.defaultAgentType,
                agentKind:
                  patch.defaultAgentType === undefined
                    ? prev.agentKind
                    : patch.defaultAgentType,
              }
            : prev,
        );
        showToast("success", "Agent defaults saved.");
      } catch (err) {
        showToast(
          "error",
          err instanceof Error ? err.message : "Couldn't save agent defaults.",
        );
      } finally {
        setIsSavingAgentDefaults(false);
      }
    },
    [actor, actorId, isSavingAgentDefaults],
  );

  const addAgentWorkspace = useCallback(
    async (path: string) => {
      if (!actor?.deviceId || !teamMqtt || !teamId || !state.currentMemberActorId) {
        showToast("error", "Daemon routing is unavailable.");
        return;
      }
      if (isAddingAgentWorkspace) return;
      setIsAddingAgentWorkspace(true);
      try {
        const rpc = createRuntimeRpcClient({
          mqtt: teamMqtt,
          teamId,
          requesterActorId: state.currentMemberActorId,
        });
        await rpc.addWorkspace({
          targetDeviceId: actor.deviceId,
          path,
          timeoutMs: 25_000,
        });
        showToast("success", "Workspace add requested.");
        await Promise.all([refresh(), reloadAgentWorkspaces()]);
      } catch (err) {
        showToast(
          "error",
          err instanceof Error ? err.message : "Couldn't add workspace.",
        );
      } finally {
        setIsAddingAgentWorkspace(false);
      }
    },
    [
      actor?.deviceId,
      isAddingAgentWorkspace,
      reloadAgentWorkspaces,
      refresh,
      state.currentMemberActorId,
      teamId,
      teamMqtt,
    ],
  );

  const removeAgentWorkspace = useCallback(
    async (workspaceId: string) => {
      if (!actor?.deviceId || !teamMqtt || !teamId || !state.currentMemberActorId) {
        showToast("error", "Daemon routing is unavailable.");
        return;
      }
      if (isRemovingAgentWorkspace) return;
      setIsRemovingAgentWorkspace(true);
      try {
        const rpc = createRuntimeRpcClient({
          mqtt: teamMqtt,
          teamId,
          requesterActorId: state.currentMemberActorId,
        });
        await rpc.removeWorkspace({
          targetDeviceId: actor.deviceId,
          workspaceId,
          timeoutMs: 25_000,
        });
        showToast("success", "Workspace remove requested.");
        await Promise.all([refresh(), reloadAgentWorkspaces()]);
      } catch (err) {
        showToast(
          "error",
          err instanceof Error ? err.message : "Couldn't remove workspace.",
        );
      } finally {
        setIsRemovingAgentWorkspace(false);
      }
    },
    [
      actor?.deviceId,
      isRemovingAgentWorkspace,
      reloadAgentWorkspaces,
      refresh,
      state.currentMemberActorId,
      teamId,
      teamMqtt,
    ],
  );

  const updateAgentVisibility = useCallback(
    async (visibility: "team" | "personal") => {
      if (!actorId || !actor || isUpdatingAgentVisibility) return;
      setIsUpdatingAgentVisibility(true);
      try {
        const api = createAgentAccessApi(supabase);
        if (visibility === "team") {
          await api.shareAgentToTeam(actorId);
        } else {
          await api.makeAgentPersonal(actorId);
        }
        setActor((prev) => (prev?.actorId === actorId ? { ...prev, visibility } : prev));
        showToast(
          "success",
          visibility === "team" ? "Agent shared to team." : "Agent made personal.",
        );
        await refresh();
      } catch (err) {
        showToast(
          "error",
          err instanceof Error ? err.message : "Couldn't update agent visibility.",
        );
      } finally {
        setIsUpdatingAgentVisibility(false);
      }
    },
    [actor, actorId, isUpdatingAgentVisibility, refresh],
  );

  return (
    <ActorDetailScreen
      actor={actor}
      agentWorkspaces={agentWorkspaces}
      authorizedHumans={authorizedHumans}
      authorizedMemberCandidates={authorizedMemberCandidates}
      isLoading={isLoading}
      isAddingAgentWorkspace={isAddingAgentWorkspace}
      isCreatingReinvite={isCreatingReinvite}
      isGrantingAuthorizedHuman={isGrantingAuthorizedHuman}
      isLoadingAuthorizedHumans={isLoadingAuthorizedHumans}
      isMe={isMe}
      isRefreshing={isRefreshing}
      isRemoving={isRemoving}
      isRemovingAgentWorkspace={isRemovingAgentWorkspace}
      isRevokingAuthorizedHuman={isRevokingAuthorizedHuman}
      isSavingAgentDefaults={isSavingAgentDefaults}
      isUpdatingAgentVisibility={isUpdatingAgentVisibility}
      onClose={() => router.back()}
      onAddAgentWorkspace={canManageAccess ? addAgentWorkspace : undefined}
      onCreateReinvite={canRemove ? createReinvite : undefined}
      onGrantAuthorizedHuman={canManageAccess ? grantAuthorizedHuman : undefined}
      onMakeAgentPersonal={
        canManageAccess && actor?.visibility !== "personal"
          ? () => void updateAgentVisibility("personal")
          : undefined
      }
      onRefresh={() => {
        void Promise.all([refresh(), reloadAuthorizedHumans()]);
      }}
      onRemoveActor={canRemove ? removeActor : undefined}
      onRemoveAgentWorkspace={canManageAccess ? removeAgentWorkspace : undefined}
      onRevokeAuthorizedHuman={canManageAccess ? revokeAuthorizedHuman : undefined}
      onSelectSession={(sessionId) => {
        router.replace(`/(app)/sessions/${sessionId}`);
      }}
      onShareAgentToTeam={
        canManageAccess && actor?.visibility === "personal"
          ? () => void updateAgentVisibility("team")
          : undefined
      }
      onUpdateAgentDefaults={actor?.actorType === "agent" ? updateAgentDefaults : undefined}
      recentSessions={recentSessions}
      stats={stats ?? undefined}
    />
  );
}
