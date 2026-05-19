import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { ActorRow } from "../../actors/components/ActorRow";
import {
  isMemberActor,
  type Actor,
} from "../../actors/actor-types";
import { IdeaRow } from "../../ideas/components/IdeaRow";
import type { Idea } from "../../ideas/idea-types";
import { SessionRow } from "../../sessions/components/SessionRow";
import type { SessionSummary } from "../../sessions/session-types";
import { Hairline } from "../../../ui/atoms/Hairline";
import { SectionEyebrow } from "../../../ui/atoms/SectionEyebrow";
import { colors, radii, spacing, typography } from "../../../ui/theme";
import { matchesAnyField, matchesQuery } from "../search-matcher";

export type SearchScreenProps = {
  actors: Actor[];
  ideas: Idea[];
  isLoading: boolean;
  onSelectActor?: (actorId: string) => void;
  onSelectIdea?: (ideaId: string) => void;
  onSelectSession?: (sessionId: string) => void;
  sessions: SessionSummary[];
};

function HeaderBar() {
  return (
    <View style={styles.headerWrap}>
      <View style={styles.headerRow}>
        <View style={styles.headerSpacer} />
      </View>
      <View style={styles.titleRow}>
        <Text style={styles.title}>Search</Text>
      </View>
    </View>
  );
}

export function SearchScreen({
  actors,
  ideas,
  isLoading,
  onSelectActor,
  onSelectIdea,
  onSelectSession,
  sessions,
}: SearchScreenProps) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(query), 80);
    return () => clearTimeout(handle);
  }, [query]);

  const trimmed = debouncedQuery.trim();

  const sessionMatches = useMemo(() => {
    if (!trimmed) return [];
    return sessions.filter((session) =>
      matchesAnyField([session.title, session.summary, session.lastMessagePreview], trimmed),
    );
  }, [sessions, trimmed]);

  const ideaMatches = useMemo(() => {
    if (!trimmed) return [];
    return ideas.filter((idea) =>
      matchesAnyField([idea.title, idea.description, idea.workspaceName], trimmed),
    );
  }, [ideas, trimmed]);

  const memberMatches = useMemo(() => {
    if (!trimmed) return [];
    return actors.filter(isMemberActor).filter((actor) => matchesQuery(actor.displayName, trimmed));
  }, [actors, trimmed]);

  const anyResults =
    sessionMatches.length + ideaMatches.length + memberMatches.length > 0;

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      style={styles.screen}
    >
      <HeaderBar />

      <View style={styles.searchField}>
        <Ionicons color={colors.slate} name="search" size={16} />
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQuery}
          placeholder="Search sessions, ideas, and members"
          placeholderTextColor={colors.slate}
          selectionColor={colors.cinnabar}
          style={styles.searchInput}
          value={query}
        />
        {query.length > 0 ? (
          <Pressable
            accessibilityLabel="Clear search"
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => setQuery("")}
          >
            <Ionicons color={colors.slate} name="close-circle" size={16} />
          </Pressable>
        ) : null}
      </View>

      {trimmed.length === 0 ? (
        <View style={styles.stateBlock}>
          {isLoading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color={colors.slate} />
              <Text style={styles.stateBody}>Loading team data…</Text>
            </View>
          ) : (
            <>
              <Text style={styles.stateTitle}>Search</Text>
              <Text style={styles.stateBody}>
                Search sessions, ideas, and members.
              </Text>
            </>
          )}
        </View>
      ) : !anyResults ? (
        <View style={styles.stateBlock}>
          <Text style={styles.stateTitle}>No results</Text>
          <Text style={styles.stateBody}>
            Nothing matched “{trimmed}”. Try different words.
          </Text>
        </View>
      ) : (
        <View style={styles.groups}>
          {sessionMatches.length > 0 ? (
            <View style={styles.section}>
              <SectionEyebrow
                label={`Sessions · ${sessionMatches.length}`}
                style={styles.sectionLabel}
              />
              <View>
                {sessionMatches.map((session, index) => (
                  <View key={session.sessionId}>
                    <SessionRow
                      onPress={() => onSelectSession?.(session.sessionId)}
                      session={session}
                    />
                    {index < sessionMatches.length - 1 ? (
                      <Hairline style={styles.rowDivider} />
                    ) : null}
                  </View>
                ))}
              </View>
            </View>
          ) : null}

          {ideaMatches.length > 0 ? (
            <View style={styles.section}>
              <SectionEyebrow
                label={`Ideas · ${ideaMatches.length}`}
                style={styles.sectionLabel}
              />
              <View>
                {ideaMatches.map((idea, index) => (
                  <View key={idea.ideaId}>
                    <Pressable onPress={() => onSelectIdea?.(idea.ideaId)}>
                      <IdeaRow idea={idea} />
                    </Pressable>
                    {index < ideaMatches.length - 1 ? (
                      <Hairline style={styles.rowDivider} />
                    ) : null}
                  </View>
                ))}
              </View>
            </View>
          ) : null}

          {memberMatches.length > 0 ? (
            <View style={styles.section}>
              <SectionEyebrow
                label={`Members · ${memberMatches.length}`}
                style={styles.sectionLabel}
              />
              <View>
                {memberMatches.map((actor, index) => (
                  <View key={actor.actorId}>
                    <Pressable onPress={() => onSelectActor?.(actor.actorId)}>
                      <ActorRow actor={actor} />
                    </Pressable>
                    {index < memberMatches.length - 1 ? (
                      <Hairline style={styles.rowDivider} />
                    ) : null}
                  </View>
                ))}
              </View>
            </View>
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
    minHeight: 16,
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
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  searchInput: {
    color: colors.onyx,
    flex: 1,
    padding: 0,
    ...typography.body,
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
  titleRow: {
    alignItems: "baseline",
    flexDirection: "row",
    gap: spacing.sm,
    paddingBottom: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
});

export default SearchScreen;
