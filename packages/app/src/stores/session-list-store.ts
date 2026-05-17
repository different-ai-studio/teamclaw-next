import { create } from "zustand";
import { supabase } from "@/lib/supabase-client";
import { useAuthStore } from "./auth-store";
import { isTauri } from "@/lib/utils";
import {
  loadSessionsForTeam,
  upsertSessionsBatch,
  type SessionRow,
} from "@/lib/local-cache";

export interface SessionListEntry {
  id: string;
  title: string;
  team_id: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  mode: "solo" | "collab" | "control";
  idea_id: string | null;
  has_unread: boolean;
}

function mapCacheToEntry(r: SessionRow): SessionListEntry {
  return {
    id: r.id,
    title: r.title ?? "",
    team_id: r.teamId,
    last_message_at: r.lastMessageAt ?? null,
    last_message_preview: r.lastMessagePreview ?? null,
    mode: (r.mode as SessionListEntry["mode"]) ?? "solo",
    idea_id: r.ideaId ?? null,
    has_unread: false,
  };
}

function mapFreshToEntry(r: {
  id: string;
  title: string;
  team_id: string;
  mode: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  idea_id: string | null;
  has_unread: boolean | null;
}): SessionListEntry {
  return {
    id: r.id,
    title: r.title ?? "",
    team_id: r.team_id,
    last_message_at: r.last_message_at,
    last_message_preview: r.last_message_preview,
    mode: (r.mode as SessionListEntry["mode"]) ?? "solo",
    idea_id: r.idea_id ?? null,
    has_unread: r.has_unread === true,
  };
}

/** Sort entries: null last_message_at first, then by last_message_at DESC */
function sortEntries(entries: SessionListEntry[]): SessionListEntry[] {
  return [...entries].sort((a, b) => {
    if (!a.last_message_at && !b.last_message_at) return 0;
    if (!a.last_message_at) return -1;
    if (!b.last_message_at) return 1;
    return b.last_message_at.localeCompare(a.last_message_at);
  });
}

interface State {
  rows: SessionListEntry[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  nextCursor: string | null;
  load: () => Promise<void>;
  markSessionViewed: (sessionId: string, lastReadMessageId?: string | null) => Promise<void>;
}

export const useSessionListStore = create<State>((set) => ({
  rows: [],
  loading: false,
  error: null,
  hasMore: false,
  nextCursor: null,
  load: async () => {
    const session = useAuthStore.getState().session;
    if (!session) {
      set({ rows: [], loading: false, error: null });
      return;
    }
    set({ loading: true, error: null });

    // Derive the team_id: use user's metadata or first row already in store
    // The primary source is the first row already loaded (set by prior loads).
    // On first boot we fall through to Supabase which populates it.
    const existingRows = useSessionListStore.getState().rows;
    const teamId = existingRows[0]?.team_id ?? null;

    // ── Phase 1: hydrate instantly from local cache (Tauri only) ──────────
    if (isTauri() && teamId) {
      const localRows = await loadSessionsForTeam(teamId);
      if (localRows.length > 0) {
        set({ rows: sortEntries(localRows.map(mapCacheToEntry)) });
      }
    }

    // ── Phase 2: pull the canonical current page from Supabase, including
    // actor-scoped read state, then mirror cacheable session fields locally.
    const { data, error } = await supabase.rpc("list_current_actor_sessions", {
      p_limit: 50,
      p_before_last_message_at: null,
    });
    if (error) {
      set({ loading: false, error: error.message });
      return;
    }

    const fresh = (data ?? []) as Array<{
      id: string;
      title: string;
      team_id: string;
      mode: string;
      last_message_at: string | null;
      last_message_preview: string | null;
      created_at: string;
      updated_at: string;
      idea_id: string | null;
      has_unread: boolean | null;
    }>;
    const nextCursor = fresh.length > 0 ? fresh[fresh.length - 1].last_message_at : null;
    const freshRows = sortEntries(fresh.map(mapFreshToEntry));

    // In non-Tauri builds (or first boot without teamId) just set rows directly
    if (!isTauri() || !teamId) {
      set({ rows: freshRows, loading: false, hasMore: fresh.length === 50, nextCursor });
      return;
    }

    // Tauri path: upsert into local cache, then re-hydrate to pick up any
    // previously-cached rows that weren't returned in the delta query.
    if (fresh.length > 0) {
      const cacheRows: SessionRow[] = fresh.map((r) => ({
        id: r.id,
        teamId: r.team_id,
        title: r.title ?? null,
        mode: r.mode ?? null,
        primaryAgentId: null,
        ideaId: r.idea_id ?? null,
        summary: null,
        lastMessagePreview: r.last_message_preview ?? null,
        lastMessageAt: r.last_message_at ?? null,
        createdBy: null,
        metadataJson: null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        deletedAt: null,
        syncedAt: new Date().toISOString(),
      }));
      await upsertSessionsBatch(cacheRows);
    }

    set({
      rows: freshRows,
      loading: false,
      hasMore: fresh.length === 50,
      nextCursor,
    });
  },
  markSessionViewed: async (sessionId, lastReadMessageId = null) => {
    const { error } = await supabase.rpc("mark_current_actor_session_viewed", {
      p_session_id: sessionId,
      p_last_read_message_id: lastReadMessageId,
    });
    if (error) {
      set({ error: error.message });
      return;
    }
    set((state) => ({
      rows: state.rows.map((row) =>
        row.id === sessionId ? { ...row, has_unread: false } : row,
      ),
    }));
  },
}));
