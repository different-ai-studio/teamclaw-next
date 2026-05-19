import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import type { SessionGroup, SessionsListState } from "../session-types";
import { SessionRow } from "../components/SessionRow";
import { PrimaryButton } from "../../../ui/button";
import { AppCard } from "../../../ui/card";
import { colors, radii, spacing, typography } from "../../../ui/theme";

type SessionsListScreenProps = {
  onLoad: () => void;
  onRefresh: () => void;
  onSelectSession: (sessionId: string) => void;
  selectedSessionId?: string | null;
  state: SessionsListState;
};

function formatCount(value: number): string {
  return value === 1 ? "1 个会话" : `${value} 个会话`;
}

function SessionGroupSection({
  group,
  onSelectSession,
  selectedSessionId,
}: {
  group: SessionGroup;
  onSelectSession: (sessionId: string) => void;
  selectedSessionId: string | null;
}) {
  return (
    <View style={styles.group}>
      <View style={styles.groupLabelRow}>
        <Text style={styles.groupLabel}>{group.label}</Text>
        <Text style={styles.groupCount}>· {group.sessions.length}</Text>
      </View>
      <View style={styles.groupItems}>
        {group.sessions.map((session) => (
          <SessionRow
            isActive={selectedSessionId === session.sessionId}
            key={session.sessionId}
            onPress={() => {
              onSelectSession(session.sessionId);
            }}
            session={session}
          />
        ))}
      </View>
    </View>
  );
}

export function SessionsListScreen({
  onLoad,
  onRefresh,
  onSelectSession,
  selectedSessionId = null,
  state,
}: SessionsListScreenProps) {
  const [placeholderMessage, setPlaceholderMessage] = useState<string | null>(null);

  const handleNewSession = () => {
    setPlaceholderMessage("新建会话即将支持。");
  };

  const header = (
    <View style={styles.headerBlock}>
      <View style={styles.header}>
        <View style={styles.headerTitleRow}>
          <Text style={styles.title}>会话</Text>
          <View style={styles.countBadge}>
            <Text style={styles.countBadgeText}>{state.sessions.length}</Text>
          </View>
        </View>
        <View style={styles.headerActions}>
          <Pressable onPress={() => {}} style={styles.headerAction}>
            <Text style={styles.headerActionText}>⌕</Text>
          </Pressable>
          <Pressable onPress={handleNewSession} style={styles.headerAction}>
            <Text style={styles.headerActionText}>✎</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );

  if (state.status === "loading" || (state.status === "idle" && state.sessions.length === 0)) {
    return (
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            onRefresh={() => {
              onRefresh();
            }}
            refreshing={state.isRefreshing}
            tintColor={colors.faint}
          />
        }
        style={styles.screen}
      >
        {header}
        {placeholderMessage ? <Text style={styles.feedback}>{placeholderMessage}</Text> : null}
        <AppCard elevated style={styles.stateCard}>
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.faint} />
            <Text style={styles.stateTitle}>加载会话中</Text>
          </View>
          <Text style={styles.stateBody}>正在获取这个团队里的最新会话。</Text>
        </AppCard>
      </ScrollView>
    );
  }

  if (state.status === "error" && state.sessions.length === 0) {
    return (
      <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
        {header}
        {placeholderMessage ? <Text style={styles.feedback}>{placeholderMessage}</Text> : null}
        <AppCard elevated style={styles.stateCard}>
          <Text style={styles.stateTitle}>无法加载会话</Text>
          <Text style={styles.stateBody}>{state.errorMessage ?? "请稍后再试。"}</Text>
          <PrimaryButton
            fullWidth={false}
            isLoading={state.isLoading}
            label="重试"
            onPress={() => {
              onLoad();
            }}
          />
        </AppCard>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          onRefresh={() => {
            onRefresh();
          }}
          refreshing={state.isRefreshing}
          tintColor={colors.faint}
        />
      }
      style={styles.screen}
    >
      {header}
      {placeholderMessage ? <Text style={styles.feedback}>{placeholderMessage}</Text> : null}

      {state.status === "error" && state.errorMessage ? (
        <AppCard compact style={styles.banner}>
          <Text style={styles.bannerText}>{state.errorMessage}</Text>
        </AppCard>
      ) : null}

      {state.groups.length > 0 ? (
        <View style={styles.groups}>
          {state.groups.map((group) => (
            <SessionGroupSection
              group={group}
              key={group.label}
              onSelectSession={onSelectSession}
              selectedSessionId={selectedSessionId}
            />
          ))}
        </View>
      ) : (
        <AppCard elevated style={styles.stateCard}>
          <Text style={styles.stateTitle}>还没有会话</Text>
          <Text style={styles.stateBody}>
            这个团队已经准备好迎接第一个会话了。当前先保留上方入口，真正的创建流程会在下一阶段接入。
          </Text>
          <PrimaryButton fullWidth={false} label="新建会话" onPress={handleNewSession} />
        </AppCard>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: colors.paper,
    borderColor: colors.border,
  },
  bannerText: {
    color: colors.ink2,
    ...typography.secondaryBody,
  },
  content: {
    gap: spacing.lg,
    padding: spacing.xxl,
  },
  feedback: {
    color: colors.faint,
    ...typography.caption,
  },
  group: {
    gap: spacing.sm,
  },
  groupCount: {
    color: colors.faint,
    ...typography.monoMeta,
  },
  groupItems: {
    gap: spacing.sm,
  },
  groupLabel: {
    color: colors.faint,
    fontSize: 10.5,
    fontWeight: "600",
    letterSpacing: 0.8,
  },
  groupLabelRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 2,
  },
  groups: {
    gap: spacing.lg,
  },
  header: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing.md,
    justifyContent: "space-between",
  },
  headerAction: {
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  headerActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
  },
  headerActionText: {
    color: colors.faint,
    fontSize: 14,
    lineHeight: 16,
  },
  headerBlock: {
    gap: spacing.sm,
  },
  headerTitleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  countBadge: {
    alignItems: "center",
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderRadius: radii.pill,
    borderWidth: 1,
    justifyContent: "center",
    minWidth: 24,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  countBadgeText: {
    color: colors.ink2,
    ...typography.monoMeta,
  },
  screen: {
    backgroundColor: colors.background,
    flex: 1,
  },
  stateBody: {
    color: colors.ink2,
    ...typography.secondaryBody,
  },
  stateCard: {
    gap: spacing.md,
  },
  stateTitle: {
    color: colors.foreground,
    ...typography.cardTitle,
  },
  title: {
    color: colors.foreground,
    ...typography.sectionTitle,
  },
});
