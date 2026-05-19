import { Redirect, Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, Share, StyleSheet, Text, View } from "react-native";

import { routeToHref, useOnboarding } from "../../../_layout";
import { createActorsApi } from "../../../../src/features/actors/actor-api";
import type { Actor } from "../../../../src/features/actors/actor-types";
import {
  loadComposerDraft,
  saveComposerDraft,
} from "../../../../src/features/sessions/composer-drafts";
import type { AgentChip } from "../../../../src/features/sessions/components/AgentChipBar";
import { createSessionsApi } from "../../../../src/features/sessions/session-api";
import { createSessionDetailController } from "../../../../src/features/sessions/session-detail-controller";
import { SessionDetailScreen } from "../../../../src/features/sessions/screens/SessionDetailScreen";
import { impactLight, selectionTick, successTone } from "../../../../src/lib/haptics";
import { showToast } from "../../../../src/ui/Toast";
import { supabase } from "../../../../src/lib/supabase/client";
import { getOptionalMqttUrl } from "../../../../src/lib/mqtt/config";
import { createExpoMqttAdapter } from "../../../../src/lib/mqtt/expo-mqtt";
import { PrimaryButton } from "../../../../src/ui/button";
import { AppCard } from "../../../../src/ui/card";
import { colors, spacing, typography } from "../../../../src/ui/theme";
import type { SessionDetailControllerState } from "../../../../src/features/sessions/session-detail-controller";

const fallbackDetailState: SessionDetailControllerState = {
  status: "loading",
  session: null,
  messages: [],
  errorMessage: null,
  connectionState: "disconnected",
  composerText: "",
  isSending: false,
  sendErrorMessage: null,
  replyTarget: null,
};

function canRenderSessionDetail(
  detailState: SessionDetailControllerState,
): detailState is SessionDetailControllerState & {
  status: "empty" | "ready" | "error";
  session: NonNullable<SessionDetailControllerState["session"]>;
} {
  return (
    detailState.session !== null &&
    (detailState.status === "empty" ||
      detailState.status === "ready" ||
      detailState.status === "error")
  );
}

export default function SessionDetailRoute() {
  const router = useRouter();
  const { sessionId: rawSessionId } = useLocalSearchParams<{
    sessionId?: string | string[];
  }>();
  const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
  const { state } = useOnboarding();
  const currentTeam = state.currentTeam;
  const href = routeToHref(state.route);
  const [controller, setController] = useState<ReturnType<typeof createSessionDetailController> | null>(
    null,
  );
  const handleBackToList = () => {
    router.replace("/(app)/sessions");
  };

  useEffect(() => {
    if (state.route !== "ready" || !sessionId || currentTeam === null) {
      setController(null);
      return;
    }

    // Best-effort mark-as-read: surfaces the session as no-longer-unread the
    // next time the list reloads. Failures are silent — the list re-derives
    // unread state from the (unchanged) read marker anyway.
    if (state.currentMemberActorId) {
      void createSessionsApi(supabase).markSessionRead(
        sessionId,
        state.currentMemberActorId,
        null,
      );
    }

    const nextController = createSessionDetailController({
      api: createSessionsApi(supabase),
      currentMemberActorId: state.currentMemberActorId,
      getAuth: async () => {
        const { data } = await supabase.auth.getSession();
        return {
          accessToken: data.session?.access_token ?? null,
          userId: data.session?.user.id ?? null,
        };
      },
      mqtt: createExpoMqttAdapter(),
      mqttUrl: getOptionalMqttUrl(),
      sessionId,
      teamId: currentTeam.id,
    });
    setController(nextController);
    void nextController.load();

    // Restore any composer draft saved for this session on a prior visit.
    void loadComposerDraft(sessionId).then((draft) => {
      if (draft.length > 0) {
        nextController.setComposerText(draft);
      }
    });

    return () => {
      void nextController.dispose();
    };
  }, [currentTeam, sessionId, state.currentMemberActorId, state.route]);

  // Persist composer text per-session as it changes (debounced via ref).
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    };
  }, []);

  if (state.route !== "ready") {
    return <Redirect href={href ?? "/"} />;
  }

  if (!sessionId || currentTeam === null) {
    return <Redirect href="/(app)/sessions" />;
  }

  const detailState = useSyncExternalStore(
    controller?.subscribe ?? (() => () => {}),
    controller?.getState ?? (() => fallbackDetailState),
    controller?.getState ?? (() => fallbackDetailState),
  );

  const [teamActors, setTeamActors] = useState<Actor[]>([]);
  const [runtimeInfo, setRuntimeInfo] = useState<
    { runtimeId: string; status: string; currentModel: string | null } | null
  >(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    void createSessionsApi(supabase)
      .loadRuntime(sessionId)
      .then((row) => {
        if (cancelled) return;
        setRuntimeInfo(
          row
            ? {
                runtimeId: row.runtimeId,
                status: row.status,
                currentModel: row.currentModel,
              }
            : null,
        );
      })
      .catch(() => {
        if (!cancelled) setRuntimeInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
  useEffect(() => {
    if (!currentTeam?.id) return;
    let cancelled = false;
    void createActorsApi(supabase)
      .listActors(currentTeam.id)
      .then((rows) => {
        if (!cancelled) setTeamActors(rows);
      })
      .catch(() => {
        if (!cancelled) setTeamActors([]);
      });
    return () => {
      cancelled = true;
    };
  }, [currentTeam?.id]);

  const agentChips: AgentChip[] = useMemo(() => {
    if (!detailState.session) return [];
    const participantIds = new Set(detailState.session.participantActorIds);
    return teamActors
      .filter((actor) => actor.actorType === "agent" && participantIds.has(actor.actorId))
      .map((actor) => ({
        agentId: actor.actorId,
        displayName: actor.displayName,
        runtimeState: "ready" as const,
      }));
  }, [detailState.session, teamActors]);

  const mentionPool = useMemo(
    () =>
      teamActors.map((actor) => ({
        actorId: actor.actorId,
        displayName: actor.displayName,
      })),
    [teamActors],
  );

  const senderNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const actor of teamActors) {
      map.set(actor.actorId, actor.displayName);
    }
    return map;
  }, [teamActors]);

  const senderAvatars = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const actor of teamActors) {
      map.set(actor.actorId, actor.avatarUrl);
    }
    return map;
  }, [teamActors]);

  const headerAvatars = useMemo(() => {
    if (!detailState.session) return [];
    const participantIds = new Set(detailState.session.participantActorIds);
    return teamActors
      .filter((actor) => participantIds.has(actor.actorId))
      .slice(0, 3)
      .map((actor) => ({
        actorId: actor.actorId,
        avatarUrl: actor.avatarUrl,
        initial: actor.displayName.charAt(0).toUpperCase() || "?",
      }));
  }, [detailState.session, teamActors]);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "会话详情" }} />
      {detailState.status === "loading" ? (
        <View style={styles.cardContainer}>
          <AppCard elevated style={styles.card}>
            <View style={styles.loadingRow}>
              <ActivityIndicator color={colors.faint} />
              <Text style={styles.cardTitle}>加载会话中</Text>
            </View>
            <Text style={styles.body}>正在准备这个会话的详情壳子。</Text>
          </AppCard>
        </View>
      ) : null}

      {detailState.status === "error" && !canRenderSessionDetail(detailState) ? (
        <View style={styles.cardContainer}>
          <AppCard elevated style={styles.card}>
            <Text style={styles.cardTitle}>无法打开会话</Text>
            <Text style={styles.body}>{detailState.errorMessage}</Text>
            <PrimaryButton
              fullWidth={false}
              label="返回会话列表"
              onPress={handleBackToList}
            />
          </AppCard>
        </View>
      ) : null}

      {detailState.status === "not-found" ? (
        <View style={styles.cardContainer}>
          <AppCard elevated style={styles.card}>
            <Text style={styles.cardTitle}>未找到会话</Text>
            <Text style={styles.body}>这个会话可能已被删除，或者你当前没有访问权限。</Text>
            <PrimaryButton
              fullWidth={false}
              label="返回会话列表"
              onPress={handleBackToList}
            />
          </AppCard>
        </View>
      ) : null}

      {canRenderSessionDetail(detailState) ? (
        <SessionDetailScreen
          agentChips={agentChips}
          composerText={detailState.composerText}
          connectionState={detailState.connectionState}
          headerAvatars={headerAvatars}
          isSending={detailState.isSending}
          mentionPool={mentionPool}
          onAttach={() => {
            router.push(`/(app)/attach?sessionId=${sessionId}`);
          }}
          onBack={handleBackToList}
          onChangeComposerText={(value) => {
            controller?.setComposerText(value);
            if (sessionId) {
              if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
              draftSaveTimer.current = setTimeout(() => {
                void saveComposerDraft(sessionId, value);
              }, 250);
            }
          }}
          onChangeRuntimeModel={
            runtimeInfo
              ? () => {
                  Alert.prompt(
                    "Change model",
                    "Set the model the runtime uses for the next turn (e.g. claude-sonnet-4-6).",
                    async (next) => {
                      const trimmed = next?.trim();
                      if (!trimmed) return;
                      try {
                        await createSessionsApi(supabase).updateRuntimeModel(
                          runtimeInfo.runtimeId,
                          trimmed,
                        );
                        setRuntimeInfo({
                          ...runtimeInfo,
                          currentModel: trimmed,
                        });
                        showToast("success", `Model set to ${trimmed}`);
                      } catch (err) {
                        showToast(
                          "error",
                          err instanceof Error ? err.message : "Couldn't update model",
                        );
                      }
                    },
                    "plain-text",
                    runtimeInfo.currentModel ?? "",
                  );
                }
              : undefined
          }
          onClearReply={() => controller?.setReplyTarget(null)}
          onDeleteMessage={async (messageId) => {
            try {
              await supabase.from("messages").delete().eq("id", messageId);
              successTone();
              showToast("success", "Message deleted");
              void controller?.load();
            } catch (err) {
              showToast(
                "error",
                err instanceof Error ? err.message : "Couldn't delete message",
              );
            }
          }}
          onEditMessage={(messageId, currentContent) => {
            Alert.prompt(
              "Edit message",
              undefined,
              async (next) => {
                const trimmed = next?.trim();
                if (!trimmed || trimmed === currentContent.trim()) return;
                try {
                  await createSessionsApi(supabase).updateMessageContent(
                    messageId,
                    trimmed,
                  );
                  void controller?.load();
                } catch {
                  // best-effort
                }
              },
              "plain-text",
              currentContent,
            );
          }}
          onOpenMembers={() => {
            router.push(`/(app)/session-members?sessionId=${sessionId}`);
          }}
          onRefresh={() => {
            void controller?.load();
          }}
          onReplyToMessage={(messageId) => {
            selectionTick();
            const target = detailState.messages.find((m) => m.messageId === messageId);
            if (target) {
              controller?.setReplyTarget({
                messageId: target.messageId,
                content: target.content,
              });
            }
          }}
          onSend={() => {
            impactLight();
            if (sessionId) {
              void saveComposerDraft(sessionId, "");
            }
            void controller?.sendMessage();
          }}
          onShare={
            sessionId
              ? async () => {
                  const session = detailState.session;
                  const title = session?.title?.trim() ?? "Teamclaw session";
                  const url = `teamclaw://session/${sessionId}`;
                  try {
                    await Share.share({ message: `${title}\n${url}`, url });
                  } catch {
                    // user cancelled or platform refused
                  }
                }
              : undefined
          }
          ownActorId={state.currentMemberActorId ?? undefined}
          replyTarget={detailState.replyTarget}
          runtimeInfo={runtimeInfo}
          senderAvatars={senderAvatars}
          senderNames={senderNames}
          sendErrorMessage={detailState.sendErrorMessage}
          state={detailState}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    color: colors.ink2,
    ...typography.secondaryBody,
  },
  card: {
    gap: spacing.md,
  },
  cardContainer: {
    padding: spacing.xxl,
  },
  cardTitle: {
    color: colors.foreground,
    ...typography.cardTitle,
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  screen: {
    backgroundColor: colors.background,
    flex: 1,
  },
});
