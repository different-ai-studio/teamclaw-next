import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session } from "@supabase/supabase-js";

const supabaseMock = {
  auth: {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(),
    signInWithOtp: vi.fn(),
    verifyOtp: vi.fn(),
    signOut: vi.fn(),
    signInAnonymously: vi.fn(),
  },
  rpc: vi.fn(),
};
const currentTeamMock = {
  reloadAndSwitchTo: vi.fn(),
};
const supabaseConfig = { hasConfig: true };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

vi.mock("@/lib/supabase-client", () => ({
  get hasSupabaseConfig() {
    return supabaseConfig.hasConfig;
  },
  SUPABASE_CONFIG_MISSING_MESSAGE: "Supabase config missing. Configure a server before signing in.",
  supabase: supabaseMock,
}));
vi.mock("@/stores/current-team", () => ({
  useCurrentTeamStore: {
    getState: () => currentTeamMock,
  },
}));

const { useAuthStore } = await import("./auth-store");

beforeEach(() => {
  Object.values(supabaseMock.auth).forEach((fn) => fn.mockReset());
  currentTeamMock.reloadAndSwitchTo.mockReset();
  supabaseConfig.hasConfig = true;
  useAuthStore.setState({
    session: null,
    loading: true,
    authFlow: "idle",
    errorMessage: null,
    otpEmail: null,
  });
});

describe("auth-store", () => {
  it("hydrate populates session from supabase.auth.getSession", async () => {
    supabaseMock.auth.getSession.mockResolvedValueOnce({ data: { session: { user: { id: "u1" } } } });
    supabaseMock.auth.onAuthStateChange.mockImplementation(() => {});
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session?.user.id).toBe("u1");
    expect(useAuthStore.getState().loading).toBe(false);
  });

  it("sendOtp stashes email and returns true on success", async () => {
    supabaseMock.auth.signInWithOtp.mockResolvedValueOnce({ error: null });
    const ok = await useAuthStore.getState().sendOtp("a@b.com");
    expect(ok).toBe(true);
    expect(useAuthStore.getState().otpEmail).toBe("a@b.com");
    expect(useAuthStore.getState().errorMessage).toBeNull();
  });

  it("sendOtp captures error and returns false on failure", async () => {
    supabaseMock.auth.signInWithOtp.mockResolvedValueOnce({ error: { message: "rate limit" } });
    const ok = await useAuthStore.getState().sendOtp("a@b.com");
    expect(ok).toBe(false);
    expect(useAuthStore.getState().errorMessage).toBe("rate limit");
    expect(useAuthStore.getState().otpEmail).toBeNull();
  });

  it("sendOtp returns a config error without calling Supabase when config is missing", async () => {
    supabaseConfig.hasConfig = false;

    const ok = await useAuthStore.getState().sendOtp("a@b.com");

    expect(ok).toBe(false);
    expect(supabaseMock.auth.signInWithOtp).not.toHaveBeenCalled();
    expect(useAuthStore.getState().errorMessage).toMatch(/Supabase config missing/);
  });

  it("verifyOtp sets session on success", async () => {
    useAuthStore.setState({ otpEmail: "a@b.com" });
    supabaseMock.auth.verifyOtp.mockResolvedValueOnce({
      data: { session: { user: { id: "u2" } } },
      error: null,
    });
    await useAuthStore.getState().verifyOtp("123456");
    expect(useAuthStore.getState().session?.user.id).toBe("u2");
    expect(useAuthStore.getState().otpEmail).toBeNull();
  });

  it("verifyOtp captures error message on failure", async () => {
    useAuthStore.setState({ otpEmail: "a@b.com" });
    supabaseMock.auth.verifyOtp.mockResolvedValueOnce({
      data: { session: null },
      error: { message: "Invalid code" },
    });
    await useAuthStore.getState().verifyOtp("000000");
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().errorMessage).toBe("Invalid code");
  });

  it("verifyOtp errors when no pending email", async () => {
    await useAuthStore.getState().verifyOtp("123456");
    expect(useAuthStore.getState().errorMessage).toMatch(/No pending sign-in/);
  });

  it("signOut clears session and pending otp", async () => {
    useAuthStore.setState({ session: { user: { id: "u" } } as unknown as Session, otpEmail: "a@b.com" });
    supabaseMock.auth.signOut.mockResolvedValueOnce({ error: null });
    await useAuthStore.getState().signOut();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().otpEmail).toBeNull();
  });

  it("signInAnonymously sets the returned session", async () => {
    supabaseMock.auth.signInAnonymously.mockResolvedValueOnce({
      data: { session: { user: { id: "anon-1" } } },
      error: null,
    });

    const ok = await useAuthStore.getState().signInAnonymously();

    expect(ok).toBe(true);
    expect(useAuthStore.getState().session?.user.id).toBe("anon-1");
    expect(useAuthStore.getState().errorMessage).toBeNull();
  });

  it("signInAnonymously returns a config error without calling Supabase when config is missing", async () => {
    supabaseConfig.hasConfig = false;

    const ok = await useAuthStore.getState().signInAnonymously();

    expect(ok).toBe(false);
    expect(supabaseMock.auth.signInAnonymously).not.toHaveBeenCalled();
    expect(useAuthStore.getState().errorMessage).toMatch(/Supabase config missing/);
  });

  it("claimInvite calls the team invite RPC", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: {
        actor_id: "actor-1",
        team_id: "team-1",
        actor_type: "member",
        display_name: "Alice",
        refresh_token: null,
      },
      error: null,
    });

    const result = await useAuthStore.getState().claimInvite("tok-1");

    expect(supabaseMock.rpc).toHaveBeenCalledWith("claim_team_invite", { p_token: "tok-1" });
    expect(result?.teamId).toBe("team-1");
  });

  it("claimInviteAfterAnonymousSignIn signs in anonymously before claiming", async () => {
    supabaseMock.auth.signInAnonymously.mockResolvedValueOnce({
      data: { session: { user: { id: "anon-2" } } },
      error: null,
    });
    supabaseMock.rpc.mockResolvedValueOnce({
      data: {
        actor_id: "actor-2",
        team_id: "team-2",
        actor_type: "member",
        display_name: "Bob",
        refresh_token: null,
      },
      error: null,
    });

    const result = await useAuthStore.getState().claimInviteAfterAnonymousSignIn("tok-2");

    expect(supabaseMock.auth.signInAnonymously).toHaveBeenCalled();
    expect(supabaseMock.rpc).toHaveBeenCalledWith("claim_team_invite", { p_token: "tok-2" });
    expect(currentTeamMock.reloadAndSwitchTo).toHaveBeenCalledWith("team-2");
    expect(result?.teamId).toBe("team-2");
  });

  it("claimInviteAfterAnonymousSignIn keeps loading true until the invited team is active", async () => {
    const switchTeam = deferred<void>();
    supabaseMock.auth.signInAnonymously.mockResolvedValueOnce({
      data: { session: { user: { id: "anon-4" } } },
      error: null,
    });
    supabaseMock.rpc.mockResolvedValueOnce({
      data: {
        actor_id: "actor-4",
        team_id: "team-4",
        actor_type: "member",
        display_name: "Dana",
        refresh_token: null,
      },
      error: null,
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

  it("claimInviteAfterAnonymousSignIn signs out when the invite claim fails", async () => {
    supabaseMock.auth.signInAnonymously.mockResolvedValueOnce({
      data: { session: { user: { id: "anon-3" } } },
      error: null,
    });
    supabaseMock.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "Invite expired" },
    });
    supabaseMock.auth.signOut.mockResolvedValueOnce({ error: null });

    const result = await useAuthStore.getState().claimInviteAfterAnonymousSignIn("expired");

    expect(result).toBeNull();
    expect(supabaseMock.auth.signOut).toHaveBeenCalled();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().authFlow).toBe("idle");
    expect(useAuthStore.getState().errorMessage).toBe("Invite expired");
  });
});
