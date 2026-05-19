import { Ionicons } from "@expo/vector-icons";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { Hairline } from "../../../ui/atoms/Hairline";
import { SectionEyebrow } from "../../../ui/atoms/SectionEyebrow";
import { PrimaryButton } from "../../../ui/button";
import { AppCard } from "../../../ui/card";
import { colors, spacing, typography } from "../../../ui/theme";
import { matchesAnyField } from "../../search/search-matcher";
import { SessionRow } from "../components/SessionRow";
import type { SessionGroup, SessionsListState } from "../session-types";

type SessionsListScreenProps = {
  onLoad: () => void;
  onNewSession?: () => void;
  onRefresh: () => void;
  onSelectSession: (sessionId: string) => void;
  onShortcuts?: () => void;
  selectedSessionId?: string | null;
  state: SessionsListState;
};

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
      <SectionEyebrow label={group.label} style={styles.groupLabel} />
      <View style={styles.groupItems}>
        {group.sessions.map((session, index) => (
          <View key={session.sessionId}>
            <SessionRow
              isActive={selectedSessionId === session.sessionId}
              onPress={() => onSelectSession(session.sessionId)}
              session={session}
            />
            {index < group.sessions.length - 1 ? (
              <Hairline style={styles.rowDivider} />
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );
}

function HeaderBar({
  count,
  onNewSession,
  onShortcuts,
}: {
  count: number;
  onNewSession: () => void;
  onShortcuts: () => void;
}) {
  return (
    <View style={styles.headerWrap}>
      <View style={styles.headerRow}>
        <Pressable onPress={onShortcuts} hitSlop={8} style={styles.toolbarButton}>
          <Ionicons name="grid-outline" size={22} color={colors.onyx} />
        </Pressable>
        <View style={styles.headerSpacer} />
        <Pressable onPress={onNewSession} hitSlop={8} style={styles.toolbarButton}>
          <Ionicons name="create-outline" size={24} color={colors.onyx} />
        </Pressable>
      </View>
      <View style={styles.titleRow}>
        <Text style={styles.title}>Sessions</Text>
        {count > 0 ? <Text style={styles.titleCount}>· {count}</Text> : null}
      </View>
    </View>
  );
}

export function SessionsListScreen({
  onLoad,
  onNewSession,
  onRefresh,
  onSelectSession,
  onShortcuts,
  selectedSessionId = null,
  state,
}: SessionsListScreenProps) {
  const [placeholderMessage, setPlaceholderMessage] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const filteredGroups = useMemo<SessionGroup[]>(() => {
    if (query.trim().length === 0) return state.groups;
    return state.groups
      .map((group) => ({
        ...group,
        sessions: group.sessions.filter((session) =>
          matchesAnyField(
            [session.title, session.summary, session.lastMessagePreview],
            query,
          ),
        ),
      }))
      .filter((group) => group.sessions.length > 0);
  }, [state.groups, query]);

  const handleNewSession = () => {
    if (onNewSession) {
      onNewSession();
      return;
    }
    setPlaceholderMessage("New session — coming next.");
  };

  const handleShortcuts = () => {
    if (onShortcuts) {
      onShortcuts();
      return;
    }
    setPlaceholderMessage("Shortcuts drawer — coming with the Shortcuts sub-spec.");
  };

  const headerBar = (
    <HeaderBar
      count={state.sessions.length}
      onNewSession={handleNewSession}
      onShortcuts={handleShortcuts}
    />
  );

  if (state.status === "loading" || (state.status === "idle" && state.sessions.length === 0)) {
    return (
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            onRefresh={onRefresh}
            refreshing={state.isRefreshing}
            tintColor={colors.slate}
          />
        }
        style={styles.screen}
      >
        {headerBar}
        {placeholderMessage ? <Text style={styles.feedback}>{placeholderMessage}</Text> : null}
        <View style={styles.stateBlock}>
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.slate} />
            <Text style={styles.stateTitle}>Loading sessions</Text>
          </View>
          <Text style={styles.stateBody}>Catching up with the team.</Text>
        </View>
      </ScrollView>
    );
  }

  if (state.status === "error" && state.sessions.length === 0) {
    return (
      <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
        {headerBar}
        {placeholderMessage ? <Text style={styles.feedback}>{placeholderMessage}</Text> : null}
        <View style={styles.stateBlock}>
          <Text style={styles.stateTitle}>Couldn't load sessions</Text>
          <Text style={styles.stateBody}>{state.errorMessage ?? "Try again in a moment."}</Text>
          <PrimaryButton
            fullWidth={false}
            isLoading={state.isLoading}
            label="Retry"
            onPress={onLoad}
          />
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          onRefresh={onRefresh}
          refreshing={state.isRefreshing}
          tintColor={colors.slate}
        />
      }
      style={styles.screen}
    >
      {headerBar}
      {placeholderMessage ? <Text style={styles.feedback}>{placeholderMessage}</Text> : null}

      {state.status === "error" && state.errorMessage ? (
        <AppCard compact style={styles.banner}>
          <Text style={styles.bannerText}>{state.errorMessage}</Text>
        </AppCard>
      ) : null}

      <View style={styles.searchField}>
        <Ionicons color={colors.slate} name="search" size={16} />
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQuery}
          placeholder="Search sessions"
          placeholderTextColor={colors.slate}
          selectionColor={colors.cinnabar}
          style={styles.searchInput}
          value={query}
        />
        {query.length > 0 ? (
          <Pressable
            accessibilityLabel="Clear search"
            accessibilityRole="button"
            hitSlop={6}
            onPress={() => setQuery("")}
          >
            <Ionicons color={colors.slate} name="close-circle" size={16} />
          </Pressable>
        ) : null}
      </View>

      {filteredGroups.length > 0 ? (
        <View style={styles.groups}>
          {filteredGroups.map((group) => (
            <SessionGroupSection
              group={group}
              key={group.label}
              onSelectSession={onSelectSession}
              selectedSessionId={selectedSessionId}
            />
          ))}
        </View>
      ) : (
        <View style={styles.stateBlock}>
          <Text style={styles.stateTitle}>No sessions yet</Text>
          <Text style={styles.stateBody}>
            Open one to start the first thread with the team's agent.
          </Text>
          <PrimaryButton fullWidth={false} label="New session" onPress={handleNewSession} />
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    marginHorizontal: spacing.lg,
  },
  bannerText: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  content: {
    gap: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  feedback: {
    color: colors.slate,
    paddingHorizontal: spacing.lg,
    ...typography.caption,
  },
  group: {
    gap: spacing.sm,
  },
  groupItems: {},
  groupLabel: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  groups: {
    gap: spacing.lg,
  },
  headerRow: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: 36,
    paddingHorizontal: spacing.lg,
  },
  headerSpacer: {
    flex: 1,
  },
  headerWrap: {
    backgroundColor: colors.mist,
    gap: spacing.md,
    paddingTop: spacing.md,
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  rowDivider: {
    marginLeft: 54,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  searchField: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  searchInput: {
    color: colors.onyx,
    flex: 1,
    padding: 0,
    ...typography.body,
  },
  stateBlock: {
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  stateBody: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  stateTitle: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
  title: {
    color: colors.onyx,
    fontSize: 34,
    fontWeight: "700",
    letterSpacing: -0.5,
    lineHeight: 38,
  },
  titleCount: {
    color: colors.slate,
    ...typography.body,
  },
  titleRow: {
    alignItems: "baseline",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  toolbarButton: {
    height: 36,
    justifyContent: "center",
    minWidth: 36,
  },
});
