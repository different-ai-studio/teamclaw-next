import { Ionicons } from "@expo/vector-icons";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { Hairline } from "../../../ui/atoms/Hairline";
import { SectionEyebrow } from "../../../ui/atoms/SectionEyebrow";
import { PrimaryButton } from "../../../ui/button";
import { colors, spacing, typography } from "../../../ui/theme";
import { ActorRow } from "../components/ActorRow";
import {
  SegmentedFilter,
  type SegmentedFilterSegment,
} from "../components/SegmentedFilter";
import {
  isAgentActor,
  isMemberActor,
  type Actor,
  type ActorsListState,
} from "../actor-types";

type Filter = "all" | "humans" | "agents";

export type ActorsListScreenProps = {
  currentActorId: string | null;
  onInvite?: () => void;
  onLoad: () => void;
  onRefresh: () => void;
  state: ActorsListState;
};

function HeaderBar({
  count,
  onInvite,
}: {
  count: number;
  onInvite?: () => void;
}) {
  return (
    <View style={styles.headerWrap}>
      <View style={styles.headerRow}>
        <View style={styles.headerSpacer} />
        <Pressable
          accessibilityLabel="Invite Member"
          accessibilityRole="button"
          disabled={!onInvite}
          hitSlop={8}
          onPress={onInvite}
          style={styles.toolbarButton}
        >
          <Ionicons
            color={onInvite ? colors.onyx : colors.slate}
            name="person-add-outline"
            size={22}
          />
        </Pressable>
      </View>
      <View style={styles.titleRow}>
        <Text style={styles.title}>Actors</Text>
        {count > 0 ? <Text style={styles.titleCount}>· {count}</Text> : null}
      </View>
    </View>
  );
}

function Section({
  actors,
  currentActorId,
  title,
}: {
  actors: Actor[];
  currentActorId: string | null;
  title: string;
}) {
  return (
    <View style={styles.section}>
      <SectionEyebrow label={title} style={styles.sectionLabel} />
      <View>
        {actors.map((actor, index) => (
          <View key={actor.actorId}>
            <ActorRow actor={actor} isMe={actor.actorId === currentActorId} />
            {index < actors.length - 1 ? <Hairline style={styles.rowDivider} /> : null}
          </View>
        ))}
      </View>
    </View>
  );
}

export function ActorsListScreen({
  currentActorId,
  onInvite,
  onLoad,
  onRefresh,
  state,
}: ActorsListScreenProps) {
  const [filter, setFilter] = useState<Filter>("all");

  const humans = useMemo(() => state.actors.filter(isMemberActor), [state.actors]);
  const agents = useMemo(() => state.actors.filter(isAgentActor), [state.actors]);

  const segments: SegmentedFilterSegment<Filter>[] = [
    { tag: "all", title: "All", count: humans.length + agents.length },
    { tag: "humans", title: "Humans", count: humans.length },
    { tag: "agents", title: "Agents", count: agents.length },
  ];

  const visibleHumans = filter === "agents" ? [] : humans;
  const visibleAgents = filter === "humans" ? [] : agents;

  const headerBar = <HeaderBar count={humans.length + agents.length} onInvite={onInvite} />;

  if (state.status === "loading" || (state.status === "idle" && state.actors.length === 0)) {
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
            <Text style={styles.stateTitle}>Loading actors</Text>
          </View>
          <Text style={styles.stateBody}>Catching up with the team roster.</Text>
        </View>
      </ScrollView>
    );
  }

  if (state.status === "error" && state.actors.length === 0) {
    return (
      <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
        {headerBar}
        <View style={styles.stateBlock}>
          <Text style={styles.stateTitle}>Couldn't load actors</Text>
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
      <SegmentedFilter onSelect={setFilter} segments={segments} selection={filter} />

      {humans.length + agents.length === 0 ? (
        <View style={styles.stateBlock}>
          <Text style={styles.stateTitle}>No Actors Yet</Text>
          <Text style={styles.stateBody}>
            Invite teammates or agents to see them here.
          </Text>
        </View>
      ) : (
        <View style={styles.groups}>
          {visibleHumans.length > 0 ? (
            <Section
              actors={visibleHumans}
              currentActorId={currentActorId}
              title={`Humans · ${visibleHumans.length}`}
            />
          ) : null}
          {visibleAgents.length > 0 ? (
            <Section
              actors={visibleAgents}
              currentActorId={currentActorId}
              title={`Agent Actors · ${visibleAgents.length}`}
            />
          ) : null}
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
    marginLeft: 70,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  section: {
    gap: spacing.sm,
  },
  sectionLabel: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
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

export default ActorsListScreen;
