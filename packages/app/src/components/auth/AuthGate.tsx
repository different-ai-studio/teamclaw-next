import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "@/stores/auth-store";
import { useCurrentTeamStore, setLocalCacheTeamGate } from "@/stores/current-team";
import { getBackend } from "@/lib/backend";
import { isTauri, removeStartupSkeleton } from "@/lib/utils";
import { devSkipDaemonOnboarding, devSkipSetup } from "@/lib/dev-onboarding-flags";
import { generateRandomTeamName } from "@/lib/random-team-name";
import { resolveDefaultDisplayName } from "@/lib/default-display-name";
import { DesktopOnboarding } from "./DesktopOnboarding";
import { LoginScreen } from "./LoginScreen";
import { SetupWizard } from "@/components/auth/SetupWizard";
import { useSetupStore, setupPreviouslySatisfied } from "@/stores/setup";
import { DaemonOnboardingWizard } from "@/components/auth/DaemonOnboardingWizard";
import { TeamBootstrapErrorScreen } from "@/components/auth/TeamBootstrapErrorScreen";
import { useDaemonOnboardingStore } from "@/stores/daemon-onboarding";
import { humanizeFcError } from "@/lib/fc-error";
import { markStartup } from "@/lib/startup-perf";

interface AuthGateProps {
  children: React.ReactNode;
}

type BootstrapState = "idle" | "checking" | "ready" | "error";

export function AuthGate({ children }: AuthGateProps) {
  const { session, loading, authFlow, hydrate, signOut } = useAuthStore();
  const [bootstrap, setBootstrap] = useState<BootstrapState>("idle");
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapNonce, setBootstrapNonce] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [authHydrated, setAuthHydrated] = useState(false);
  const bootstrappedUserId = useRef<string | null>(null);

  const setupLoaded = useSetupStore((s) => s.loaded);
  const setupRequiredSatisfied = useSetupStore((s) => s.requiredSatisfied());
  const listSetup = useSetupStore((s) => s.listRequirements);
  // Optimistic skip: if a prior launch confirmed all required deps, don't gate
  // first paint behind the cold `setup_list_requirements` probe (~4s on macOS
  // first launch — it spawns `amuxd doctor`). The probe still runs in the
  // background (effect below) to refresh the cache, and the daemon-onboarding
  // gate is the real backstop if a dependency actually went missing.
  const [setupAck, setSetupAck] = useState(() => devSkipSetup() || setupPreviouslySatisfied());

  const daemonStatus = useDaemonOnboardingStore((s) => s.status);
  const daemonLoaded = useDaemonOnboardingStore((s) => s.loaded);
  const refreshDaemonOnboarding = useDaemonOnboardingStore((s) => s.refresh);
  const [daemonOnboardingAck, setDaemonOnboardingAck] = useState(() => devSkipDaemonOnboarding());

  useEffect(() => {
    if (isTauri()) void listSetup();
  }, [listSetup]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve(hydrate()).finally(() => {
      if (!cancelled) setAuthHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, [hydrate]);

  useEffect(() => {
    markStartup("authgate:mount");
  }, []);

  useEffect(() => {
    if (isTauri() && session && bootstrap === "ready") void refreshDaemonOnboarding()
  }, [session, bootstrap, refreshDaemonOnboarding]);

  // After auth: ensure the user belongs to at least one team. If not (fresh
  // signup, no invites), auto-create a temporary team so the UI lands
  // somewhere usable instead of an empty shell. Tauri-only for now.
  //
  // The ref guard (instead of a cleanup-driven `cancelled` flag) is
  // deliberate: under React strict mode the effect runs twice, and a
  // cancelled-flag pattern would mark the in-flight request as discarded
  // and leave bootstrap pinned at "checking" forever.
  useEffect(() => {
    if (loading) return;
    if (!session) {
      bootstrappedUserId.current = null;
      setBootstrap("idle");
      setBootstrapError(null);
      setRetrying(false);
      return;
    }
    if (!isTauri()) {
      setBootstrap("ready");
      return;
    }
    if (bootstrappedUserId.current === session.user.id) return;
    bootstrappedUserId.current = session.user.id;
    markStartup("team-bootstrap:start");

    // Optimistic cold start: if we already hold a team for THIS user — hydrated
    // synchronously from the persisted cache, or just set by an invite flow —
    // render the shell immediately instead of blocking first paint behind the
    // team-bootstrap network round-trips. App's mount-time load() revalidates
    // and reconciles in the background. The teamUserId match is mandatory: a
    // cached team from a previous user (localStorage survives logout) must NOT
    // be reused; that session falls through to a full re-resolve below.
    const snapshot = useCurrentTeamStore.getState();
    if (snapshot.team && snapshot.teamUserId === session.user.id) {
      // Prime the backend's team gate so the team-scoped session-cache reads
      // App fires on mount are accepted (cold path used to set this during
      // bootstrap, before App mounted). Fire-and-forget: the IPC is fast and
      // App's load() re-sets it shortly after anyway.
      void setLocalCacheTeamGate(snapshot.team.id);
      setBootstrap("ready");
      markStartup("team-bootstrap:end");
      return;
    }

    setBootstrap("checking");

    void (async () => {
      let teamSet = false;
      let bootErr: unknown = null;
      try {
        const teams = await getBackend().teams.listCurrentUserTeams({ limit: 1 });
        markStartup("team-list:end");
        // The list row already carries {id,name,slug}, so adopt it directly via
        // setActiveTeam instead of reloadAndSwitchTo — the latter re-fetches the
        // same team with a redundant GET /v1/teams/:id on the critical path.
        const existing = teams[0];
        if (existing) {
          await useCurrentTeamStore.getState().setActiveTeam({
            id: existing.id,
            name: existing.name,
            slug: existing.slug ?? "",
          });
          teamSet = true;
        } else {
          // Seed the owner's display name from their real identity (OS full
          // name / email prefix) so they don't land as "You". Omitting it lets
          // the server synthesize a stable handle.
          const name = generateRandomTeamName();
          const displayName = await resolveDefaultDisplayName(session?.user?.email);
          const created = await getBackend().teams.createTeam({ name, displayName });
          if (created?.id) {
            await useCurrentTeamStore.getState().setActiveTeam({
              id: created.id,
              name: created.name,
              slug: created.slug ?? "",
            });
            teamSet = true;
            console.log("[AuthGate] auto-created team", name);
          } else {
            bootErr = new Error("create_team returned no team id");
          }
        }
      } catch (err) {
        bootErr = err;
        console.warn("[AuthGate] team bootstrap failed", err);
      }
      markStartup("team-bootstrap:end");
      setRetrying(false);
      if (teamSet) {
        setBootstrapError(null);
        setBootstrap("ready");
      } else {
        // No current team means the app can't continue — daemon onboarding,
        // sessions and the actor directory are all team-scoped. Surface the
        // failure with a retry instead of silently dropping into an empty,
        // half-broken shell (the previous behavior swallowed this error).
        setBootstrapError(humanizeFcError(bootErr));
        setBootstrap("error");
      }
    })();
  }, [loading, session, bootstrapNonce]);

  const retryBootstrap = () => {
    // Re-arm the per-user ref guard and bump the nonce so the bootstrap effect
    // runs again. `retrying` keeps the error screen up (with a spinner) instead
    // of flashing back to the skeleton while the retry is in flight.
    bootstrappedUserId.current = null;
    setRetrying(true);
    setBootstrapNonce((n) => n + 1);
  };

  // Each gate below either (a) is a pure-loading state — return null so the
  // static #skeleton (z-9999, mirrors the real shell) keeps showing through an
  // empty #root, no blank flash; or (b) renders real/interactive UI — tear the
  // skeleton down first so the screen is visible and clickable. The happy path
  // (children) deliberately does NOT remove the skeleton here: App removes it
  // once the workspace resolves, so the hand-off goes skeleton → real UI with
  // no intermediate spinner.

  // First-run: in Tauri, ensure local prerequisites (amuxd/opencode) before auth.
  if (isTauri() && !setupAck) {
    if (!setupLoaded) {
      return null;
    }
    if (!setupRequiredSatisfied) {
      removeStartupSkeleton();
      return <SetupWizard onDone={() => setSetupAck(true)} />;
    }
  }

  if (isTauri() && loading && authFlow === "invite") {
    removeStartupSkeleton();
    return <DesktopOnboarding />;
  }

  if (!authHydrated && loading) {
    return null;
  }

  if (!session) {
    removeStartupSkeleton();
    return isTauri() ? <DesktopOnboarding /> : <LoginScreen />;
  }

  if (loading) {
    return null;
  }

  // Team bootstrap failed (e.g. createTeam rejected by a drifted backend).
  // Surface it with a retry; `retrying` keeps this up while a retry re-resolves.
  if (isTauri() && (bootstrap === "error" || retrying)) {
    removeStartupSkeleton();
    return (
      <TeamBootstrapErrorScreen
        error={bootstrapError}
        busy={retrying}
        onRetry={retryBootstrap}
        onSignOut={() => void signOut()}
      />
    );
  }

  if (isTauri() && bootstrap !== "ready") {
    return null;
  }

  // Daemon readiness gate: after login + workspace bootstrap, ensure the local
  // daemon is bound to the current team AND running with a valid token. Interactive
  // states (needs-onboard / mismatch) prompt the user; transient states (starting /
  // error) auto-recover or offer retry. 'ready'/'unknown' fall through.
  if (isTauri() && !daemonOnboardingAck) {
    if (!daemonLoaded) {
      return null;
    }
    if (
      daemonStatus === 'needs-onboard' ||
      daemonStatus === 'mismatch' ||
      daemonStatus === 'starting' ||
      daemonStatus === 'error'
    ) {
      removeStartupSkeleton();
      return <DaemonOnboardingWizard onDone={() => setDaemonOnboardingAck(true)} />;
    }
  }

  markStartup("authgate:children");
  return <>{children}</>;
}
