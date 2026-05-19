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

import { matchesAnyField } from "../../search/search-matcher";


import {
  SegmentedFilter,
  type SegmentedFilterSegment,
} from "../../actors/components/SegmentedFilter";
import { Hairline } from "../../../ui/atoms/Hairline";
import { PrimaryButton } from "../../../ui/button";
import { colors, spacing, typography } from "../../../ui/theme";
import { IdeaRow } from "../components/IdeaRow";
import {
  isDoneIdea,
  isMineIdea,
  isOpenIdea,
  type IdeasListState,
} from "../idea-types";

type Filter = "all" | "mine" | "open" | "done";

export type IdeasListScreenProps = {
  currentActorId: string | null;
  onCreate?: () => void;
  onLoad: () => void;
  onRefresh: () => void;
  onSelectIdea?: (ideaId: string) => void;
  state: IdeasListState;
};

function HeaderBar({
  count,
  onCreate,
}: {
  count: number;
  onCreate?: () => void;
}) {
  return (
    <View style={styles.headerWrap}>
      <View style={styles.headerRow}>
        <View style={styles.headerSpacer} />
        <Pressable
          accessibilityLabel="Create Idea"
          accessibilityRole="button"
          disabled={!onCreate}
          hitSlop={8}
          onPress={onCreate}
          style={styles.toolbarButton}
        >
          <Ionicons
            color={onCreate ? colors.onyx : colors.slate}
            name="add"
            size={26}
          />
        </Pressable>
      </View>
      <View style={styles.titleRow}>
        <Text style={styles.title}>Ideas</Text>
        {count > 0 ? <Text style={styles.titleCount}>· {count}</Text> : null}
      </View>
    </View>
  );
}

export function IdeasListScreen({
  currentActorId,
  onCreate,
  onLoad,
  onRefresh,
  onSelectIdea,
  state,
}: IdeasListScreenProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const searched = useMemo(
    () =>
      query.trim().length === 0
        ? state.ideas
        : state.ideas.filter((idea) =>
            matchesAnyField([idea.title, idea.description, idea.workspaceName], query),
          ),
    [state.ideas, query],
  );

  const counts = useMemo(() => {
    let mine = 0;
    let open = 0;
    let done = 0;
    for (const idea of searched) {
      if (isMineIdea(idea, currentActorId)) mine += 1;
      if (isOpenIdea(idea)) open += 1;
      if (isDoneIdea(idea)) done += 1;
    }
    return { mine, open, done };
  }, [searched, currentActorId]);

  const segments: SegmentedFilterSegment<Filter>[] = [
    { tag: "all", title: "All", count: searched.length },
    ...(currentActorId
      ? [{ tag: "mine" as const, title: "Mine", count: counts.mine }]
      : []),
    { tag: "open", title: "Open", count: counts.open },
    { tag: "done", title: "Done", count: counts.done },
  ];

  const filteredIdeas = searched.filter((idea) => {
    if (filter === "all") return true;
    if (filter === "mine") return isMineIdea(idea, currentActorId);
    if (filter === "open") return isOpenIdea(idea);
    if (filter === "done") return isDoneIdea(idea);
    return true;
  });

  const headerBar = <HeaderBar count={state.ideas.length} onCreate={onCreate} />;

  if (state.status === "loading" || (state.status === "idle" && state.ideas.length === 0)) {
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
        <View style={styles.stateBlock}>
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.slate} />
            <Text style={styles.stateTitle}>Loading ideas</Text>
          </View>
          <Text style={styles.stateBody}>Catching up with the team's notes.</Text>
        </View>
      </ScrollView>
    );
  }

  if (state.status === "error" && state.ideas.length === 0) {
    return (
      <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
        {headerBar}
        <View style={styles.stateBlock}>
          <Text style={styles.stateTitle}>Couldn't load ideas</Text>
          <Text style={styles.stateBody}>{state.errorMessage ?? "Try again in a moment."}</Text>
          <PrimaryButton fullWidth={false} label="Retry" onPress={onLoad} />
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

      <View style={styles.searchField}>
        <Ionicons color={colors.slate} name="search" size={16} />
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQuery}
          placeholder="Search ideas"
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

      <SegmentedFilter onSelect={setFilter} segments={segments} selection={filter} />

      {state.ideas.length === 0 ? (
        <View style={styles.stateBlock}>
          <Text style={styles.stateTitle}>No Ideas</Text>
          <Text style={styles.stateBody}>Tap + to create an idea.</Text>
        </View>
      ) : filteredIdeas.length === 0 ? (
        <View style={styles.stateBlock}>
          <Text style={styles.emptyFilterTitle}>
            {filter === "mine"
              ? "Nothing here yet"
              : filter === "open"
              ? "No open ideas"
              : filter === "done"
              ? "No completed ideas"
              : "No ideas"}
          </Text>
          <Text style={styles.emptyFilterBody}>
            {filter === "mine"
              ? "Ideas you create will show up here."
              : filter === "open"
              ? "Open ideas will appear once created."
              : filter === "done"
              ? "Mark an idea as Done to see it here."
              : "Tap + to create an idea."}
          </Text>
        </View>
      ) : (
        <View>
          {filteredIdeas.map((idea, index) => (
            <View key={idea.ideaId}>
              <Pressable
                onPress={onSelectIdea ? () => onSelectIdea(idea.ideaId) : undefined}
              >
                <IdeaRow idea={idea} />
              </Pressable>
              {index < filteredIdeas.length - 1 ? (
                <Hairline style={styles.rowDivider} />
              ) : null}
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.md,
    paddingBottom: spacing.xxxl,
  },
  emptyFilterBody: {
    color: colors.slate,
    ...typography.caption,
  },
  emptyFilterTitle: {
    color: colors.basalt,
    ...typography.secondaryBody,
    fontWeight: "600",
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
    marginHorizontal: spacing.lg,
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
    paddingBottom: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  toolbarButton: {
    height: 36,
    justifyContent: "center",
    minWidth: 36,
  },
});

export default IdeasListScreen;
