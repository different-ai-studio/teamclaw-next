import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Modal } from "react-native";

import { useOnboarding } from "../_layout";
import { createActorsApi } from "../../src/features/actors/actor-api";
import { isAgentActor, type Actor } from "../../src/features/actors/actor-types";
import { createSessionsApi } from "../../src/features/sessions/session-api";
import { MemberPickerSheet } from "../../src/features/sessions/screens/MemberPickerSheet";
import { SessionMemberSheet } from "../../src/features/sessions/screens/SessionMemberSheet";
import { supabase } from "../../src/lib/supabase/client";
import { showToast } from "../../src/ui/Toast";
import { TextPromptModal } from "../../src/ui/TextPromptModal";

type AddMode = "all" | "members" | "agents";

type AgentRuntime = {
  runtimeId: string;
  agentId: string;
  currentModel: string | null;
  status: string;
};

type RuntimeRow = {
  id: string | null;
  agent_id: string | null;
  current_model: string | null;
  status: string | null;
};

export default function SessionMembersRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const params = useLocalSearchParams<{ sessionId?: string }>();
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
  const teamId = state.currentTeam?.id ?? "";

  const [actors, setActors] = useState<Actor[]>([]);
  const [participantIds, setParticipantIds] = useState<string[]>([]);
  const [runtimes, setRuntimes] = useState<AgentRuntime[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [addMode, setAddMode] = useState<AddMode | null>(null);
  const [modelPromptAgent, setModelPromptAgent] = useState<AgentRuntime | null>(
    null,
  );

  useEffect(() => {
    if (!teamId || !sessionId) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    const sessionsApi = createSessionsApi(supabase);
    const actorsApi = createActorsApi(supabase);
    void Promise.all([
      sessionsApi.getSession(teamId, sessionId),
      actorsApi.listActors(teamId),
      supabase
        .from("agent_runtimes")
        .select("id, agent_id, current_model, status")
        .eq("session_id", sessionId),
    ])
      .then(([session, allActors, runtimeResult]) => {
        if (cancelled) return;
        setParticipantIds(session?.participantActorIds ?? []);
        setActors(allActors);
        const result = runtimeResult as {
          data: RuntimeRow[] | null;
          error: unknown;
        };
        const rows: AgentRuntime[] = (result.data ?? [])
          .filter((row): row is RuntimeRow & { id: string; agent_id: string } =>
            Boolean(row.id && row.agent_id),
          )
          .map((row) => ({
            runtimeId: row.id,
            agentId: row.agent_id,
            currentModel: row.current_model,
            status: row.status ?? "unknown",
          }));
        setRuntimes(rows);
      })
      .catch(() => {
        if (cancelled) return;
        setActors([]);
        setParticipantIds([]);
        setRuntimes([]);
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

  const pickerCandidates = useMemo(() => {
    if (!addMode) return [] as Actor[];
    if (addMode === "members") return actors.filter((actor) => actor.actorType === "member");
    if (addMode === "agents") return actors.filter(isAgentActor);
    return actors;
  }, [actors, addMode]);

  const agentModelByActorId = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const runtime of runtimes) {
      map.set(runtime.agentId, runtime.currentModel);
    }
    return map;
  }, [runtimes]);

  const findRuntimeForAgent = (actorId: string): AgentRuntime | null => {
    return runtimes.find((row) => row.agentId === actorId) ?? null;
  };

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

  const handleAdd = async (picked: string[]) => {
    if (!sessionId) {
      setAddMode(null);
      return;
    }
    const fresh = picked.filter((id) => !participantIds.includes(id));
    if (fresh.length === 0) {
      setAddMode(null);
      return;
    }
    try {
      await createSessionsApi(supabase).addParticipants(sessionId, fresh);
      setParticipantIds((prev) => Array.from(new Set([...prev, ...fresh])));
      showToast(
        "success",
        fresh.length === 1 ? "Added to session" : `Added ${fresh.length} to session`,
      );
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Couldn't add participants",
      );
    } finally {
      setAddMode(null);
    }
  };

  const handleChangeModel = (actorId: string) => {
    const runtime = findRuntimeForAgent(actorId);
    if (!runtime) {
      showToast(
        "error",
        "This agent's runtime isn't online — wait for it to reconnect.",
      );
      return;
    }
    setModelPromptAgent(runtime);
  };

  const handleRestart = (actorId: string) => {
    const runtime = findRuntimeForAgent(actorId);
    if (!runtime) {
      showToast(
        "error",
        "This agent's runtime isn't online — wait for it to reconnect.",
      );
      return;
    }
    // Runtime restart in iOS goes through the daemon RPC stack (proto
    // request/response over MQTT). The Expo client doesn't yet implement
    // that pipeline, so surface a clear "use the desktop app" message
    // rather than silently no-op.
    showToast(
      "error",
      "Restart isn't supported from mobile yet — use the desktop app.",
    );
  };

  return (
    <>
      <SessionMemberSheet
        actors={participants}
        agentModelByActorId={agentModelByActorId}
        currentActorId={state.currentMemberActorId ?? null}
        isLoading={isLoading}
        onAddAgent={() => setAddMode("agents")}
        onAddMember={() => setAddMode("members")}
        onChangeAgentModel={handleChangeModel}
        onClose={() => router.back()}
        onRemoveActor={handleRemove}
        onRestartAgentRuntime={handleRestart}
      />
      <Modal
        animationType="slide"
        onRequestClose={() => setAddMode(null)}
        presentationStyle="pageSheet"
        visible={addMode !== null}
      >
        <MemberPickerSheet
          actors={pickerCandidates}
          excludeActorIds={participantIds}
          onCancel={() => setAddMode(null)}
          onConfirm={handleAdd}
        />
      </Modal>
      <TextPromptModal
        confirmLabel="Update"
        description="Set the model the runtime uses for the next turn (e.g. claude-sonnet-4-6)."
        initialValue={modelPromptAgent?.currentModel ?? ""}
        isVisible={modelPromptAgent !== null}
        onCancel={() => setModelPromptAgent(null)}
        onSubmit={async (next) => {
          const target = modelPromptAgent;
          const trimmed = next.trim();
          setModelPromptAgent(null);
          if (!target || !trimmed) return;
          try {
            await createSessionsApi(supabase).updateRuntimeModel(
              target.runtimeId,
              trimmed,
            );
            setRuntimes((prev) =>
              prev.map((row) =>
                row.runtimeId === target.runtimeId
                  ? { ...row, currentModel: trimmed }
                  : row,
              ),
            );
            showToast("success", `Model set to ${trimmed}`);
          } catch (err) {
            showToast(
              "error",
              err instanceof Error ? err.message : "Couldn't update model",
            );
          }
        }}
        placeholder="claude-sonnet-4-6"
        title="Change model"
      />
    </>
  );
}
