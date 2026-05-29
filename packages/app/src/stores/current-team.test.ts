import { describe, it, expect, vi, beforeEach } from "vitest";

const teamsMock = {
  listCurrentUserTeams: vi.fn(),
  getTeam: vi.fn(),
  renameTeam: vi.fn(),
};
const directoryMock = {
  getCurrentTeamMember: vi.fn(),
};
const backendMock = {
  teams: teamsMock,
  directory: directoryMock,
};

const authState: { session: { user: { id: string } } | null } = {
  session: { user: { id: "anon-1" } },
};

vi.mock("@/lib/backend", () => ({
  getBackend: () => backendMock,
}));

vi.mock("./auth-store", () => ({
  useAuthStore: {
    getState: () => authState,
  },
}));

// current-team dynamically imports the Tauri core to set the local-cache gate;
// stub it so the store runs in the jsdom test environment.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

const { useCurrentTeamStore } = await import("./current-team");

const ACTIVE_TEAM = { id: "team-1", name: "Brave Otter", slug: "brave-otter" };
const ACTIVE_MEMBER = {
  id: "member-1",
  displayName: "You",
  role: "owner",
  joinedAt: "2026-05-29T00:00:00.000Z",
};

beforeEach(() => {
  teamsMock.listCurrentUserTeams.mockReset();
  directoryMock.getCurrentTeamMember.mockReset();
  authState.session = { user: { id: "anon-1" } };
  useCurrentTeamStore.setState({
    team: null,
    currentMember: null,
    loading: false,
    saving: false,
    error: null,
  });
});

describe("useCurrentTeamStore.load", () => {
  it("does not clobber an already-active team when the list comes back empty (RLS replica lag)", async () => {
    // AuthGate already populated the store with the freshly auto-created team.
    useCurrentTeamStore.setState({ team: ACTIVE_TEAM, currentMember: ACTIVE_MEMBER });
    // The follow-up list query can't see the just-written membership yet.
    teamsMock.listCurrentUserTeams.mockResolvedValueOnce([]);

    await useCurrentTeamStore.getState().load();

    const state = useCurrentTeamStore.getState();
    expect(state.team).toEqual(ACTIVE_TEAM);
    expect(state.currentMember).toEqual(ACTIVE_MEMBER);
    expect(state.loading).toBe(false);
    // We bailed before re-fetching the member.
    expect(directoryMock.getCurrentTeamMember).not.toHaveBeenCalled();
  });

  it("clears the team for a genuinely team-less session (empty list, no prior team)", async () => {
    teamsMock.listCurrentUserTeams.mockResolvedValueOnce([]);

    await useCurrentTeamStore.getState().load();

    const state = useCurrentTeamStore.getState();
    expect(state.team).toBeNull();
    expect(state.currentMember).toBeNull();
    expect(state.loading).toBe(false);
  });

  it("loads the team and current member when the list returns a team", async () => {
    teamsMock.listCurrentUserTeams.mockResolvedValueOnce([ACTIVE_TEAM]);
    directoryMock.getCurrentTeamMember.mockResolvedValueOnce(ACTIVE_MEMBER);

    await useCurrentTeamStore.getState().load();

    const state = useCurrentTeamStore.getState();
    expect(state.team).toEqual(ACTIVE_TEAM);
    expect(state.currentMember).toEqual(ACTIVE_MEMBER);
    expect(directoryMock.getCurrentTeamMember).toHaveBeenCalledWith("team-1", "anon-1");
  });
});
