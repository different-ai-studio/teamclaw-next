import { describe, it, expect, vi, beforeEach } from "vitest";

const authMock = {
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  sendOtp: vi.fn(),
  verifyOtp: vi.fn(),
  signOut: vi.fn(),
  signInAnonymously: vi.fn(),
  claimInvite: vi.fn(),
  sendUpgradeEmailOtp: vi.fn(),
  verifyUpgradeEmailOtp: vi.fn(),
};
const backendMock = {
  auth: authMock,
};
const backendConfig = { hasConfig: true };
const session = {
  user: { id: "u1", email: "u1@example.com" },
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: 12345,
};

const currentTeamMock = {
  reloadAndSwitchTo: vi.fn(),
};

function storeSessionLike(userId: string) {
  return {
    user: { id: userId, email: null },
    accessToken: `access-${userId}`,
    refreshToken: `refresh-${userId}`,
    expiresAt: 99999,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

vi.mock("@/lib/backend", () => ({
  getBackend: () => backendMock,
  hasBackendConfig: () => backendConfig.hasConfig,
  BACKEND_CONFIG_MISSING_MESSAGE: "Supabase config missing. Configure a server before signing in.",
}));

vi.mock("@/stores/current-team", () => ({
  useCurrentTeamStore: {
    getState: () => currentTeamMock,
  },
}));

const { useAuthStore } = await import("./auth-store");

beforeEach(() => {
  Object.values(authMock).forEach((fn) => fn.mockReset());
  currentTeamMock.reloadAndSwitchTo.mockReset();
  backendConfig.hasConfig = true;
  useAuthStore.setState({
    session: null,
    loading: true,
    authFlow: "idle",
    errorMessage: null,
    otpEmail: null,
  });
});

describe("auth-store", () => {
  it("hydrate populates session from backend auth", async () => {
    authMock.getSession.mockResolvedValueOnce(session);
    authMock.onAuthStateChange.mockImplementation(() => {});
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session?.user.id).toBe("u1");
    expect(useAuthStore.getState().session?.access_token).toBe("access-1");
    expect(useAuthStore.getState().session?.refresh_token).toBe("refresh-1");
    expect(useAuthStore.getState().session?.expires_at).toBe(12345);
    expect(useAuthStore.getState().loading).toBe(false);
  });

  it("hydrate auth listener stores token compatibility aliases", async () => {
    authMock.getSession.mockResolvedValueOnce(null);
    authMock.onAuthStateChange.mockImplementation((listener) => {
      listener({
        user: { id: "u-listener", email: "listener@example.com" },
        accessToken: "access-listener",
        refreshToken: "refresh-listener",
        expiresAt: 67890,
      });
    });

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().session).toMatchObject({
      user: { id: "u-listener" },
      accessToken: "access-listener",
      refreshToken: "refresh-listener",
      expiresAt: 67890,
      access_token: "access-listener",
      refresh_token: "refresh-listener",
      expires_at: 67890,
    });
  });

  it("sendOtp stashes email and returns true on success", async () => {
    authMock.sendOtp.mockResolvedValueOnce(undefined);
    const ok = await useAuthStore.getState().sendOtp("a@b.com");
    expect(ok).toBe(true);
    expect(authMock.sendOtp).toHaveBeenCalledWith("a@b.com");
    expect(useAuthStore.getState().otpEmail).toBe("a@b.com");
    expect(useAuthStore.getState().errorMessage).toBeNull();
  });

  it("sendOtp captures error and returns false on failure", async () => {
    authMock.sendOtp.mockRejectedValueOnce(new Error("rate limit"));
    const ok = await useAuthStore.getState().sendOtp("a@b.com");
    expect(ok).toBe(false);
    expect(useAuthStore.getState().errorMessage).toBe("rate limit");
    expect(useAuthStore.getState().otpEmail).toBeNull();
  });

  it("sendOtp returns a config error without calling Supabase when config is missing", async () => {
    backendConfig.hasConfig = false;

    const ok = await useAuthStore.getState().sendOtp("a@b.com");

    expect(ok).toBe(false);
    expect(authMock.sendOtp).not.toHaveBeenCalled();
    expect(useAuthStore.getState().errorMessage).toMatch(/Supabase config missing/);
  });

  it("verifyOtp sets session on success", async () => {
    useAuthStore.setState({ otpEmail: "a@b.com" });
    authMock.verifyOtp.mockResolvedValueOnce({ user: { id: "u2" } });
    await useAuthStore.getState().verifyOtp("123456");
    expect(authMock.verifyOtp).toHaveBeenCalledWith("a@b.com", "123456");
    expect(useAuthStore.getState().session?.user.id).toBe("u2");
    expect(useAuthStore.getState().otpEmail).toBeNull();
  });

  it("verifyOtp captures error message on failure", async () => {
    useAuthStore.setState({ otpEmail: "a@b.com" });
    authMock.verifyOtp.mockRejectedValueOnce(new Error("Invalid code"));
    await useAuthStore.getState().verifyOtp("000000");
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().errorMessage).toBe("Invalid code");
  });

  it("verifyOtp errors when no pending email", async () => {
    await useAuthStore.getState().verifyOtp("123456");
    expect(useAuthStore.getState().errorMessage).toMatch(/No pending sign-in/);
  });

  it("signOut clears session and pending otp", async () => {
    useAuthStore.setState({ session: { user: { id: "u" } }, otpEmail: "a@b.com" });
    authMock.signOut.mockResolvedValueOnce(undefined);
    await useAuthStore.getState().signOut();
    expect(authMock.signOut).toHaveBeenCalled();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().otpEmail).toBeNull();
  });

  it("signInAnonymously sets the returned session", async () => {
    authMock.signInAnonymously.mockResolvedValueOnce({ user: { id: "anon-1" } });

    const ok = await useAuthStore.getState().signInAnonymously();

    expect(ok).toBe(true);
    expect(useAuthStore.getState().session?.user.id).toBe("anon-1");
    expect(useAuthStore.getState().errorMessage).toBeNull();
  });

  it("signInAnonymously returns a config error without calling Supabase when config is missing", async () => {
    backendConfig.hasConfig = false;

    const ok = await useAuthStore.getState().signInAnonymously();

    expect(ok).toBe(false);
    expect(authMock.signInAnonymously).not.toHaveBeenCalled();
    expect(useAuthStore.getState().errorMessage).toMatch(/Supabase config missing/);
  });

  it("claimInvite claims the token through backend auth", async () => {
    authMock.claimInvite.mockResolvedValueOnce({
      actorId: "actor-1",
      teamId: "team-1",
      actorType: "member",
      displayName: "Alice",
      refreshToken: null,
    });

    const result = await useAuthStore.getState().claimInvite("tok-1");

    expect(authMock.claimInvite).toHaveBeenCalledWith("tok-1");
    expect(result?.teamId).toBe("team-1");
  });

  it("claimInviteAfterAnonymousSignIn signs in anonymously before claiming", async () => {
    authMock.signInAnonymously.mockResolvedValueOnce({ user: { id: "anon-2" } });
    authMock.claimInvite.mockResolvedValueOnce({
      actorId: "actor-2",
      teamId: "team-2",
      actorType: "member",
      displayName: "Bob",
      refreshToken: null,
    });

    const result = await useAuthStore.getState().claimInviteAfterAnonymousSignIn("tok-2");

    expect(authMock.signInAnonymously).toHaveBeenCalled();
    expect(authMock.claimInvite).toHaveBeenCalledWith("tok-2");
    expect(currentTeamMock.reloadAndSwitchTo).toHaveBeenCalledWith("team-2");
    expect(result?.teamId).toBe("team-2");
  });

  it("claimInviteAfterAnonymousSignIn keeps loading true until the invited team is active", async () => {
    const switchTeam = deferred<void>();
    authMock.signInAnonymously.mockResolvedValueOnce({ user: { id: "anon-4" } });
    authMock.claimInvite.mockResolvedValueOnce({
      actorId: "actor-4",
      teamId: "team-4",
      actorType: "member",
      displayName: "Dana",
      refreshToken: null,
    });
    currentTeamMock.reloadAndSwitchTo.mockReturnValueOnce(switchTeam.promise);

    const resultPromise = useAuthStore.getState().claimInviteAfterAnonymousSignIn("tok-4");
    await vi.waitFor(() => expect(currentTeamMock.reloadAndSwitchTo).toHaveBeenCalledWith("team-4"));

    expect(useAuthStore.getState().loading).toBe(true);
    expect(useAuthStore.getState().authFlow).toBe("invite");

    switchTeam.resolve();
    const result = await resultPromise;

    expect(result?.teamId).toBe("team-4");
    expect(useAuthStore.getState().loading).toBe(false);
    expect(useAuthStore.getState().authFlow).toBe("idle");
  });

  it("sendUpgradeEmailOtp does not flip the global loading flag (AuthGate would tear down the app)", async () => {
    // Authenticated, app mounted: session present, global loading already false.
    useAuthStore.setState({ session: storeSessionLike("anon-up"), loading: false, upgradeEmail: null });
    const pending = deferred<void>();
    authMock.sendUpgradeEmailOtp.mockReturnValueOnce(pending.promise);

    const resultPromise = useAuthStore.getState().sendUpgradeEmailOtp("taken@example.com");

    // While in-flight the global `loading` must stay false so AuthGate keeps the
    // app (and the upgrade dialog) mounted; the dedicated flag tracks progress.
    expect(useAuthStore.getState().loading).toBe(false);
    expect(useAuthStore.getState().upgradeLoading).toBe(true);

    pending.resolve();
    await resultPromise;
    expect(useAuthStore.getState().upgradeLoading).toBe(false);
  });

  it("sendUpgradeEmailOtp surfaces the error without disturbing global loading on failure", async () => {
    useAuthStore.setState({ session: storeSessionLike("anon-up"), loading: false, upgradeEmail: null });
    authMock.sendUpgradeEmailOtp.mockRejectedValueOnce(
      new Error("A user with this email address has already been registered"),
    );

    const ok = await useAuthStore.getState().sendUpgradeEmailOtp("taken@example.com");

    expect(ok).toBe(false);
    expect(useAuthStore.getState().loading).toBe(false);
    expect(useAuthStore.getState().upgradeLoading).toBe(false);
    expect(useAuthStore.getState().errorMessage).toMatch(/already been registered/);
    expect(useAuthStore.getState().upgradeEmail).toBeNull();
  });

  it("verifyUpgradeEmailOtp does not flip the global loading flag while verifying", async () => {
    useAuthStore.setState({ session: storeSessionLike("anon-up"), loading: false, upgradeEmail: "taken@example.com" });
    const pending = deferred<{ user: { id: string } }>();
    authMock.verifyUpgradeEmailOtp.mockReturnValueOnce(pending.promise);

    const resultPromise = useAuthStore.getState().verifyUpgradeEmailOtp("123456");

    expect(useAuthStore.getState().loading).toBe(false);
    expect(useAuthStore.getState().upgradeLoading).toBe(true);

    pending.resolve({ user: { id: "anon-up" } });
    await resultPromise;
    expect(useAuthStore.getState().upgradeLoading).toBe(false);
  });

  it("claimInviteAfterAnonymousSignIn signs out when the invite claim fails", async () => {
    authMock.signInAnonymously.mockResolvedValueOnce({ user: { id: "anon-3" } });
    authMock.claimInvite.mockRejectedValueOnce(new Error("Invite expired"));
    authMock.signOut.mockResolvedValueOnce(undefined);

    const result = await useAuthStore.getState().claimInviteAfterAnonymousSignIn("expired");

    expect(result).toBeNull();
    expect(authMock.signOut).toHaveBeenCalled();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().authFlow).toBe("idle");
    expect(useAuthStore.getState().errorMessage).toBe("Invite expired");
  });
});
