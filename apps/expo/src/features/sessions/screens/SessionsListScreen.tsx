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
  onArchiveBatch?: (sessionIds: string[]) => Promise<void>;
  onLoad: () => void;
  onMarkBatchRead?: (sessionIds: string[]) => Promise<void>;
  onNewSession?: () => void;
  onRefresh: () => void;
  onSelectSession: (sessionId: string) => void;
  onTogglePin?: (sessionId: string) => Promise<void> | void;
  pinnedSessionIds?: ReadonlySet<string>;
  onShortcuts?: () => void;
  selectedSessionId?: string | null;
  state: SessionsListState;
};

function SessionGroupSection({
  group,
  onLongPressSession,
  onSelectSession,
  selectedSessionId,
  selectionMode,
  selection,
}: {
  group: SessionGroup;
  onLongPressSession?: (id: string) => void;
  onSelectSession: (sessionId: string) => void;
  selectedSessionId: string | null;
  selectionMode: boolean;
  selection: ReadonlySet<string>;
}) {
  return (
    <View style={styles.group}>
      <SectionEyebrow label={group.label} style={styles.groupLabel} />
      <View style={styles.groupItems}>
        {group.sessions.map((session, index) => {
          const checked = selection.has(session.sessionId);
          return (
            <View
              key={session.sessionId}
              style={[styles.sessionRowOuter, checked ? styles.sessionRowChecked : null]}
            >
              {selectionMode ? (
                <View style={[styles.checkbox, checked ? styles.checkboxOn : null]}>
                  {checked ? (
                    <Ionicons color="#F8F6F1" name="checkmark" size={14} />
                  ) : null}
                </View>
              ) : null}
              <View style={{ flex: 1 }}>
                <SessionRow
                  isActive={selectedSessionId === session.sessionId}
                  onLongPress={
                    onLongPressSession
                      ? () => onLongPressSession(session.sessionId)
                      : undefined
                  }
                  onPress={(s) => onSelectSession(s.sessionId)}
                  session={session}
                />
              </View>
              {index < group.sessions.length - 1 ? (
                <Hairline style={styles.rowDivider} />
              ) : null}
            </View>
          );
        })}
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
  onArchiveBatch,
  onLoad,
  onMarkBatchRead,
  onNewSession,
  onRefresh,
  onSelectSession,
  onShortcuts,
  onTogglePin,
  pinnedSessionIds,
  selectedSessionId = null,
  state,
}: SessionsListScreenProps) {
  const [placeholderMessage, setPlaceholderMessage] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [isBatchBusy, setIsBatchBusy] = useState(false);
  const selectionMode = selection.size > 0;
  const toggleSelection = (id: string) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelection(new Set());
  const handleArchiveSelected = async () => {
    if (!onArchiveBatch || selection.size === 0) return;
    setIsBatchBusy(true);
    try {
      await onArchiveBatch(Array.from(selection));
      clearSelection();
    } finally {
      setIsBatchBusy(false);
    }
  };

  const handleMarkReadSelected = async () => {
    if (!onMarkBatchRead || selection.size === 0) return;
    setIsBatchBusy(true);
    try {
      await onMarkBatchRead(Array.from(selection));
      clearSelection();
    } finally {
      setIsBatchBusy(false);
    }
  };

  const filteredGroups = useMemo<SessionGroup[]>(() => {
    const filtered =
      query.trim().length === 0
        ? state.groups
        : state.groups
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

    if (!pinnedSessionIds || pinnedSessionIds.size === 0) return filtered;
    const pinned: SessionGroup["sessions"] = [];
    const rest: SessionGroup = { label: "今天", sessions: [] };
    const remainingGroups: SessionGroup[] = [];
    for (const group of filtered) {
      const remaining: SessionGroup["sessions"] = [];
      for (const session of group.sessions) {
        if (pinnedSessionIds.has(session.sessionId)) pinned.push(session);
        else remaining.push(session);
      }
      if (remaining.length > 0) remainingGroups.push({ ...group, sessions: remaining });
    }
    if (pinned.length === 0) return remainingGroups;
    const pinnedGroup: SessionGroup = { label: "今天", sessions: pinned };
    // Reuse the existing eyebrow look but force a synthetic group label.
    (pinnedGroup as unknown as { label: string }).label = `PINNED · ${pinned.length}`;
    void rest;
    return [pinnedGroup, ...remainingGroups];
  }, [state.groups, query, pinnedSessionIds]);

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
    <View style={styles.screen}>
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          onRefresh={onRefresh}
          refreshing={state.isRefreshing}
          tintColor={colors.slate}
        />
      }
      style={{ flex: 1 }}
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
              onLongPressSession={(id) => toggleSelection(id)}
              onSelectSession={(id) => {
                if (selectionMode) {
                  toggleSelection(id);
                } else {
                  onSelectSession(id);
                }
              }}
              selectedSessionId={selectedSessionId}
              selection={selection}
              selectionMode={selectionMode}
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

    {selectionMode ? (
      <View style={styles.batchBar}>
        <Text style={styles.batchCount}>{selection.size} selected</Text>
        <Pressable
          accessibilityRole="button"
          onPress={clearSelection}
          style={({ pressed }) => [styles.batchAction, pressed ? styles.batchActionPressed : null]}
        >
          <Text style={styles.batchActionText}>Cancel</Text>
        </Pressable>
        {onTogglePin ? (
          <Pressable
            accessibilityRole="button"
            disabled={isBatchBusy}
            onPress={async () => {
              for (const id of selection) await onTogglePin(id);
              clearSelection();
            }}
            style={({ pressed }) => [
              styles.batchAction,
              pressed && !isBatchBusy ? styles.batchActionPressed : null,
            ]}
          >
            <Text style={styles.batchActionText}>Pin</Text>
          </Pressable>
        ) : null}
        {onMarkBatchRead ? (
          <Pressable
            accessibilityRole="button"
            disabled={isBatchBusy}
            onPress={handleMarkReadSelected}
            style={({ pressed }) => [
              styles.batchAction,
              pressed && !isBatchBusy ? styles.batchActionPressed : null,
            ]}
          >
            <Text style={styles.batchActionText}>Mark read</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          disabled={isBatchBusy || !onArchiveBatch}
          onPress={handleArchiveSelected}
          style={({ pressed }) => [
            styles.batchPrimary,
            isBatchBusy ? styles.batchPrimaryBusy : null,
            pressed && !isBatchBusy ? styles.batchActionPressed : null,
          ]}
        >
          <Text style={styles.batchPrimaryText}>
            {isBatchBusy ? "Archiving…" : "Archive"}
          </Text>
        </Pressable>
      </View>
    ) : null}
    </View>
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
  batchAction: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  batchActionPressed: {
    opacity: 0.7,
  },
  batchActionText: {
    color: colors.basalt,
    ...typography.body,
  },
  batchBar: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderTopColor: colors.hairline,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md,
  },
  batchCount: {
    color: colors.onyx,
    flex: 1,
    ...typography.body,
    fontWeight: "600",
  },
  batchPrimary: {
    backgroundColor: "rgba(184,75,54,0.12)",
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  batchPrimaryBusy: {
    opacity: 0.5,
  },
  batchPrimaryText: {
    color: colors.cinnabar,
    ...typography.body,
    fontWeight: "700",
  },
  checkbox: {
    alignItems: "center",
    borderColor: colors.slate,
    borderRadius: 999,
    borderWidth: 1.5,
    height: 22,
    justifyContent: "center",
    marginLeft: spacing.lg,
    width: 22,
  },
  checkboxOn: {
    backgroundColor: colors.cinnabar,
    borderColor: colors.cinnabar,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  sessionRowChecked: {
    backgroundColor: "rgba(184,75,54,0.06)",
  },
  sessionRowOuter: {
    alignItems: "center",
    flexDirection: "row",
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
