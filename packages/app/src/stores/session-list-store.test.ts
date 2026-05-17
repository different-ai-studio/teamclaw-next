import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "./auth-store";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock("@/lib/supabase-client", () => ({
  supabase: {
    rpc: mocks.rpc,
    auth: {
      getSession: vi.fn(),
      onAuthStateChange: vi.fn(),
      signInWithOtp: vi.fn(),
      verifyOtp: vi.fn(),
      signOut: vi.fn(),
    },
  },
}));

vi.mock("@/lib/utils", () => ({
  isTauri: () => false,
}));

const sessionRow = (overrides: Partial<{
  id: string;
  title: string;
  last_message_at: string | null;
  created_at: string;
  has_unread: boolean;
}> = {}) => ({
  id: "session-1",
  title: "Session",
  team_id: "team-1",
  mode: "collab",
  idea_id: null,
  last_message_at: "2026-05-17T08:00:00.000Z",
  last_message_preview: "preview",
  created_at: "2026-05-17T07:59:00.000Z",
  updated_at: "2026-05-17T08:00:01.000Z",
  has_unread: false,
  ...overrides,
});

describe("session-list-store", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { useSessionListStore } = await import("./session-list-store");
    useSessionListStore.setState({
      rows: [],
      loading: false,
      error: null,
      hasMore: false,
      nextCursor: null,
    });
    useAuthStore.setState({
      session: { user: { id: "user-1" } },
      loading: false,
      errorMessage: null,
      otpEmail: null,
    } as never);
  });

  it("loads the first page from the current actor session RPC", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [sessionRow({ has_unread: true })],
      error: null,
    });

    const { useSessionListStore } = await import("./session-list-store");
    await useSessionListStore.getState().loadFirstPage();

    expect(mocks.rpc).toHaveBeenCalledWith("list_current_actor_sessions", {
      p_limit: 50,
      p_before_last_message_at: null,
      p_before_created_at: null,
      p_before_id: null,
    });
    expect(useSessionListStore.getState().rows[0]).toMatchObject({
      id: "session-1",
      has_unread: true,
    });
  });

  it("loads more with the last row composite cursor and dedupes rows", async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: [
          sessionRow({
            id: "session-1",
            last_message_at: "2026-05-17T08:00:00.000Z",
            created_at: "2026-05-17T07:59:00.000Z",
          }),
          sessionRow({
            id: "session-2",
            last_message_at: "2026-05-17T07:00:00.000Z",
            created_at: "2026-05-17T06:59:00.000Z",
          }),
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [
          sessionRow({
            id: "session-2",
            last_message_at: "2026-05-17T07:00:00.000Z",
            created_at: "2026-05-17T06:59:00.000Z",
          }),
          sessionRow({
            id: "session-3",
            last_message_at: "2026-05-17T06:00:00.000Z",
            created_at: "2026-05-17T05:59:00.000Z",
          }),
        ],
        error: null,
      });

    const { useSessionListStore } = await import("./session-list-store");
    await useSessionListStore.getState().loadFirstPage(2);
    await useSessionListStore.getState().loadMore(2);

    expect(mocks.rpc).toHaveBeenLastCalledWith("list_current_actor_sessions", {
      p_limit: 2,
      p_before_last_message_at: "2026-05-17T07:00:00.000Z",
      p_before_created_at: "2026-05-17T06:59:00.000Z",
      p_before_id: "session-2",
    });
    expect(useSessionListStore.getState().rows.map((row) => row.id)).toEqual([
      "session-1",
      "session-2",
      "session-3",
    ]);
  });

  it("marks the current actor session viewed and clears local unread state", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });

    const { useSessionListStore } = await import("./session-list-store");
    useSessionListStore.setState({
      rows: [sessionRow({ has_unread: true })],
    });

    await useSessionListStore.getState().markSessionViewed("session-1");

    expect(mocks.rpc).toHaveBeenCalledWith("mark_current_actor_session_viewed", {
      p_session_id: "session-1",
      p_last_read_message_id: null,
    });
    expect(useSessionListStore.getState().rows[0].has_unread).toBe(false);
  });
});
