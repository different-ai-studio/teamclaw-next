import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { authState, currentTeamMock, backendMock } = vi.hoisted(() => ({
  authState: {
    session: { user: { id: "user-1" } },
    loading: false,
    authFlow: "idle" as "idle" | "invite",
    hydrate: vi.fn(),
  },
  currentTeamMock: {
    reloadAndSwitchTo: vi.fn(),
    setActiveTeam: vi.fn(),
    team: null as null | { id: string },
  },
  backendMock: {
    teams: {
      listCurrentUserTeams: vi.fn(),
      createTeam: vi.fn(),
    },
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: () => authState,
}));

vi.mock("@/stores/current-team", () => ({
  useCurrentTeamStore: {
    getState: () => currentTeamMock,
  },
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => backendMock,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(" "),
  isTauri: () => true,
}));

vi.mock("@/lib/random-team-name", () => ({
  generateRandomTeamName: () => "Trial Team",
}));

vi.mock("@/stores/setup", () => ({
  useSetupStore: (selector: (s: { loaded: boolean; requiredSatisfied: () => boolean; listRequirements: () => void }) => unknown) =>
    selector({ loaded: true, requiredSatisfied: () => true, listRequirements: () => {} }),
}));

vi.mock("../SetupWizard", () => ({
  SetupWizard: ({ onDone }: { onDone: () => void }) => (
    <button onClick={onDone}>Setup wizard</button>
  ),
}));

vi.mock("@/stores/daemon-onboarding", () => ({
  useDaemonOnboardingStore: (selector: (s: { status: string; loaded: boolean; refresh: () => Promise<void> }) => unknown) =>
    selector({ status: 'ready', loaded: true, refresh: async () => {} }),
}));

vi.mock("../DaemonOnboardingWizard", () => ({
  DaemonOnboardingWizard: ({ onDone }: { onDone: () => void }) => (
    <button onClick={onDone}>Daemon onboarding wizard</button>
  ),
}));

vi.mock("../DesktopOnboarding", () => ({
  DesktopOnboarding: () => <div>Desktop onboarding</div>,
}));

vi.mock("../LoginScreen", () => ({
  LoginScreen: () => <div>Login screen</div>,
}));

import { AuthGate } from "../AuthGate";

beforeEach(() => {
  authState.session = { user: { id: "user-1" } };
  authState.loading = false;
  authState.authFlow = "idle";
  authState.hydrate.mockReset();
  backendMock.teams.listCurrentUserTeams.mockReset();
  backendMock.teams.createTeam.mockReset();
  currentTeamMock.reloadAndSwitchTo.mockReset();
  currentTeamMock.setActiveTeam.mockReset();
  currentTeamMock.team = null;
});

describe("AuthGate", () => {
  it("keeps the shell blocked while an authenticated onboarding operation is loading", async () => {
    authState.loading = true;

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("App shell")).not.toBeInTheDocument());
  });

  it("keeps desktop onboarding mounted while an unauthenticated action is loading", async () => {
    authState.session = null;
    authState.loading = false;

    const view = render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(screen.getByText("Desktop onboarding")).toBeInTheDocument());

    authState.loading = true;
    view.rerender(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    expect(screen.getByText("Desktop onboarding")).toBeInTheDocument();
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    expect(screen.queryByText("App shell")).not.toBeInTheDocument();
  });

  it("keeps desktop onboarding mounted while an invite claim has an anonymous session", async () => {
    authState.session = { user: { id: "anon-invite" } };
    authState.loading = true;
    authState.authFlow = "invite";

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(screen.getByText("Desktop onboarding")).toBeInTheDocument());
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    expect(screen.queryByText("App shell")).not.toBeInTheDocument();
  });

  it("creates a first team and switches to it before rendering the shell", async () => {
    backendMock.teams.listCurrentUserTeams.mockResolvedValueOnce([]);
    backendMock.teams.createTeam.mockResolvedValueOnce({
      id: "team-new",
      name: "Trial Team",
      slug: "trial-team",
    });
    currentTeamMock.setActiveTeam.mockResolvedValueOnce(undefined);

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() =>
      expect(currentTeamMock.setActiveTeam).toHaveBeenCalledWith({
        id: "team-new",
        name: "Trial Team",
        slug: "trial-team",
      }),
    );
    await waitFor(() => expect(screen.getByText("App shell")).toBeInTheDocument());
  });
});
