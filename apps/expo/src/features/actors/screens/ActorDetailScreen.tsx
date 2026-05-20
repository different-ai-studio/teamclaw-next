import { Ionicons } from "@expo/vector-icons";
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
import { StatusDot } from "../../../ui/atoms/StatusDot";
import { formatRelativeTime } from "../../../lib/relative-time";
import { colors, hai, radii, spacing, typography } from "../../../ui/theme";
import { isActorOnline, type Actor } from "../actor-types";

export type ActorDetailScreenProps = {
  actor: Actor | null;
  isLoading: boolean;
  isMe: boolean;
  isRefreshing?: boolean;
  onClose: () => void;
  onRefresh?: () => void;
  onSelectSession?: (sessionId: string) => void;
  recentSessions?: ReadonlyArray<{
    sessionId: string;
    title: string;
    lastMessageAt: string;
  }>;
  stats?: {
    sessions: number;
    ideas: number;
  };
};

const HUMAN_PALETTE = [hai.basalt, hai.slate, hai.sage, hai.onyx];

function avatarInitials(name: string): string {
  const parts = name
    .split(/[\s·]+/)
    .filter(Boolean)
    .slice(0, 2);
  if (parts.length === 0) return name.slice(0, 1).toUpperCase();
  return parts.map((p) => p.charAt(0).toUpperCase()).join("");
}

function hashActorId(actorId: string): number {
  let hash = 0;
  for (let i = 0; i < actorId.length; i += 1) hash = (hash + actorId.charCodeAt(i)) >>> 0;
  return hash;
}

function deriveHeroStyle(actor: Actor, isMe: boolean) {
  if (actor.actorType === "agent") {
    return { background: hai.pebble, foreground: hai.basalt, isSquare: true };
  }
  if (isMe) {
    return { background: hai.cinnabar, foreground: hai.paper, isSquare: false };
  }
  return {
    background: HUMAN_PALETTE[hashActorId(actor.actorId) % HUMAN_PALETTE.length],
    foreground: hai.paper,
    isSquare: false,
  };
}

function deriveKindLabel(actor: Actor): string {
  if (actor.actorType === "member") return "Human";
  if (actor.actorType === "agent") return "Agent";
  return "External";
}

function deriveSubtitle(actor: Actor, isMe: boolean): string {
  if (isMe) return "you";
  if (actor.actorType === "agent") return "Agent";
  return actor.role ?? "member";
}

export function ActorDetailScreen({
  actor,
  isLoading,
  isMe,
  isRefreshing,
  onClose,
  onRefresh,
  onSelectSession,
  recentSessions,
  stats,
}: ActorDetailScreenProps) {
  return (
    <View style={styles.screen}>
      <View style={styles.headerBar}>
        <View style={styles.headerSlot} />
        <Text style={styles.headerTitle}>Actor</Text>
        <Pressable hitSlop={8} onPress={onClose} style={styles.headerSlot}>
          <Ionicons color={colors.onyx} name="close" size={26} />
        </Pressable>
      </View>
      <Hairline />

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          onRefresh ? (
            <RefreshControl
              onRefresh={onRefresh}
              refreshing={Boolean(isRefreshing)}
              tintColor={colors.slate}
            />
          ) : undefined
        }
      >
        {isLoading && actor === null ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.slate} />
            <Text style={styles.loadingText}>Loading actor…</Text>
          </View>
        ) : actor === null ? (
          <View style={styles.stateBlock}>
            <Text style={styles.stateTitle}>Actor not found</Text>
            <Text style={styles.stateBody}>
              The actor may have been removed from this team.
            </Text>
          </View>
        ) : (
          <>
            <HeroCard actor={actor} isMe={isMe} />

            {stats ? (
              <View style={styles.statsRow}>
                <View style={styles.statTile}>
                  <Text style={styles.statValue}>{stats.sessions}</Text>
                  <Text style={styles.statLabel}>Sessions</Text>
                </View>
                <View style={styles.statTile}>
                  <Text style={styles.statValue}>{stats.ideas}</Text>
                  <Text style={styles.statLabel}>Ideas</Text>
                </View>
              </View>
            ) : null}

            {recentSessions ? (
              <View style={styles.section}>
                <SectionEyebrow
                  label={
                    recentSessions.length > 0
                      ? `RECENT SESSIONS · ${recentSessions.length}`
                      : "RECENT SESSIONS"
                  }
                  style={styles.sectionEyebrow}
                />
                <View style={styles.card}>
                  {recentSessions.length === 0 ? (
                    <Text style={styles.emptyRecent}>No recent sessions yet.</Text>
                  ) : null}
                  {recentSessions.map((row, index) => {
                    const ts = row.lastMessageAt
                      ? Date.parse(row.lastMessageAt)
                      : 0;
                    const isFresh = ts > 0 && Date.now() - ts < 5 * 60 * 1000;
                    return (
                      <View key={row.sessionId}>
                        <Pressable
                          accessibilityRole="button"
                          onPress={
                            onSelectSession
                              ? () => onSelectSession(row.sessionId)
                              : undefined
                          }
                          style={({ pressed }) => [
                            styles.recentSessionRow,
                            pressed && onSelectSession ? { opacity: 0.7 } : null,
                          ]}
                        >
                          <StatusDot kind={isFresh ? "active" : "muted"} size={8} />
                          <Text numberOfLines={1} style={styles.recentSessionTitle}>
                            {row.title || "Untitled session"}
                          </Text>
                          <Text style={styles.recentSessionTime}>
                            {row.lastMessageAt ? formatRelativeTime(row.lastMessageAt) : "—"}
                          </Text>
                        </Pressable>
                        {index < recentSessions.length - 1 ? <Hairline /> : null}
                      </View>
                    );
                  })}
                </View>
              </View>
            ) : null}

            <View style={styles.section}>
              <SectionEyebrow label="INFO" style={styles.sectionEyebrow} />
              <View style={styles.card}>
                <DetailRow label="Name" value={actor.displayName} />
                <Hairline />
                <DetailRow label="Kind" value={deriveKindLabel(actor)} />
                <Hairline />
                <DetailRow
                  label={actor.actorType === "member" ? "Role" : "Status"}
                  value={deriveSubtitle(actor, isMe)}
                />
                <Hairline />
                <DetailRow
                  label="Online"
                  value={isActorOnline(actor) ? "Yes" : "No"}
                />
              </View>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function HeroCard({ actor, isMe }: { actor: Actor; isMe: boolean }) {
  const style = deriveHeroStyle(actor, isMe);
  const initials = avatarInitials(actor.displayName);
  const online = isActorOnline(actor);
  return (
    <View style={styles.hero}>
      <View
        style={[
          styles.heroAvatar,
          {
            backgroundColor: style.background,
            borderRadius: style.isSquare ? 16 : 999,
          },
        ]}
      >
        <Text style={[styles.heroAvatarText, { color: style.foreground }]}>{initials}</Text>
      </View>
      <View style={styles.heroBody}>
        <Text numberOfLines={1} style={styles.heroName}>
          {actor.displayName}
        </Text>
        <View style={styles.heroStatusRow}>
          <View
            style={[
              styles.heroDot,
              { backgroundColor: online ? hai.sage : hai.slate },
            ]}
          />
          <Text style={styles.heroStatus}>{online ? "Online" : "Offline"}</Text>
          <Text style={styles.heroSeparator}>·</Text>
          <Text style={styles.heroKind}>{deriveKindLabel(actor)}</Text>
        </View>
      </View>
    </View>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  content: {
    gap: spacing.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  detailLabel: {
    color: colors.basalt,
    ...typography.body,
  },
  detailRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  detailValue: {
    color: colors.onyx,
    ...typography.body,
  },
  recentSessionRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  recentSessionTime: {
    color: colors.slate,
    ...typography.caption,
  },
  recentSessionTitle: {
    color: colors.onyx,
    flex: 1,
    ...typography.body,
  },
  emptyRecent: {
    color: colors.slate,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    ...typography.secondaryBody,
  },
  headerBar: {
    alignItems: "center",
    backgroundColor: colors.mist,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 48,
    paddingHorizontal: spacing.xs,
  },
  headerSlot: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 40,
    minWidth: 40,
  },
  headerTitle: {
    color: colors.onyx,
    ...typography.sectionTitle,
  },
  hero: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.md,
    padding: spacing.lg,
  },
  heroAvatar: {
    alignItems: "center",
    height: 72,
    justifyContent: "center",
    width: 72,
  },
  heroAvatarText: {
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  heroBody: {
    flex: 1,
    gap: 6,
  },
  heroDot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  heroKind: {
    color: colors.slate,
    ...typography.caption,
  },
  heroName: {
    color: colors.onyx,
    ...typography.cardTitle,
  },
  heroSeparator: {
    color: colors.slate,
    ...typography.caption,
  },
  heroStatus: {
    color: colors.basalt,
    ...typography.caption,
  },
  heroStatusRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  loadingText: {
    color: colors.basalt,
    ...typography.secondaryBody,
  },
  screen: {
    backgroundColor: colors.mist,
    flex: 1,
  },
  section: {
    gap: spacing.sm,
  },
  sectionEyebrow: {
    paddingHorizontal: spacing.xs,
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
  statLabel: {
    color: colors.slate,
    ...typography.monoMeta,
  },
  statTile: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderColor: colors.hairline,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    gap: 4,
    paddingVertical: spacing.md,
  },
  statValue: {
    color: colors.onyx,
    fontSize: 22,
    fontWeight: "700",
  },
  statsRow: {
    flexDirection: "row",
    gap: spacing.md,
  },
});

export default ActorDetailScreen;
