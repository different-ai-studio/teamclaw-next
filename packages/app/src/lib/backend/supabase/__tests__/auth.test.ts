import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseAuthBackend } from "../auth";
import { createSupabaseDirectoryBackend } from "../directory";

const session = {
  access_token: "access-1",
  refresh_token: "refresh-1",
  expires_at: 12345,
  user: {
    id: "user-1",
    email: "user@example.com",
    app_metadata: { provider: "email" },
  },
};

describe("Supabase auth backend", () => {
  let client: {
    auth: {
      getSession: ReturnType<typeof vi.fn>;
      onAuthStateChange: ReturnType<typeof vi.fn>;
      signInWithOtp: ReturnType<typeof vi.fn>;
      verifyOtp: ReturnType<typeof vi.fn>;
      signInAnonymously: ReturnType<typeof vi.fn>;
      signOut: ReturnType<typeof vi.fn>;
    };
    rpc: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    client = {
      auth: {
        getSession: vi.fn(),
        onAuthStateChange: vi.fn(),
        signInWithOtp: vi.fn(),
        verifyOtp: vi.fn(),
        signInAnonymously: vi.fn(),
        signOut: vi.fn(),
      },
      rpc: vi.fn(),
    };
  });

  it("getSession maps Supabase session to provider-neutral shape", async () => {
    client.auth.getSession.mockResolvedValueOnce({ data: { session }, error: null });

    const result = await createSupabaseAuthBackend(client).getSession();

    expect(result).toEqual({
      user: {
        id: "user-1",
        email: "user@example.com",
        providerData: session.user,
      },
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: 12345,
      providerData: session,
    });
  });

  it("onAuthStateChange maps Supabase session and unsubscribes", () => {
    const unsubscribe = vi.fn();
    client.auth.onAuthStateChange.mockImplementation((listener) => {
      listener("SIGNED_IN", session);
      return { data: { subscription: { unsubscribe } } };
    });
    const listener = vi.fn();

    const stop = createSupabaseAuthBackend(client).onAuthStateChange(listener);
    stop();

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "access-1" }));
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("sendOtp calls Supabase with shouldCreateUser", async () => {
    client.auth.signInWithOtp.mockResolvedValueOnce({ error: null });

    await createSupabaseAuthBackend(client).sendOtp("user@example.com");

    expect(client.auth.signInWithOtp).toHaveBeenCalledWith({
      email: "user@example.com",
      options: { shouldCreateUser: true },
    });
  });

  it("claimInvite calls the existing RPC and maps actor/team fields", async () => {
    client.rpc.mockResolvedValueOnce({
      data: [
        {
          actor_id: "actor-1",
          team_id: "team-1",
          actor_type: "member",
          display_name: "Alice",
          refresh_token: "refresh-claim",
        },
      ],
      error: null,
    });

    const result = await createSupabaseAuthBackend(client).claimInvite("invite-token");

    expect(client.rpc).toHaveBeenCalledWith("claim_team_invite", { p_token: "invite-token" });
    expect(result).toEqual({
      actorId: "actor-1",
      teamId: "team-1",
      actorType: "member",
      displayName: "Alice",
      refreshToken: "refresh-claim",
    });
  });
});

describe("Supabase directory backend", () => {
  it("resolveCurrentMemberActor queries actors", async () => {
    const maybeSingle = vi.fn().mockResolvedValueOnce({
      data: { id: "actor-1", display_name: "Ignored" },
      error: null,
    });
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      limit: vi.fn(),
      maybeSingle,
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.limit.mockReturnValue(query);
    const client = {
      from: vi.fn().mockReturnValue(query),
    };

    const result = await createSupabaseDirectoryBackend(client).resolveCurrentMemberActor("team-1", "user-1");

    expect(client.from).toHaveBeenCalledWith("actors");
    expect(query.select).toHaveBeenCalledWith("id");
    expect(query.eq).toHaveBeenCalledWith("team_id", "team-1");
    expect(query.eq).toHaveBeenCalledWith("user_id", "user-1");
    expect(query.eq).toHaveBeenCalledWith("actor_type", "member");
    expect(query.limit).toHaveBeenCalledWith(1);
    expect(query.maybeSingle).toHaveBeenCalled();
    expect(result).toEqual({ id: "actor-1" });
  });

  it("resolveCurrentMemberActor returns null when no actor matches", async () => {
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      limit: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValueOnce({ data: null, error: null }),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.limit.mockReturnValue(query);
    const client = {
      from: vi.fn().mockReturnValue(query),
    };

    const result = await createSupabaseDirectoryBackend(client).resolveCurrentMemberActor("team-1", "user-1");

    expect(result).toBeNull();
  });

  it("resolveFirstMemberActorForUser uses deterministic actor ordering", async () => {
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      order: vi.fn(),
      limit: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValueOnce({
        data: { id: "actor-1", team_id: "team-1" },
        error: null,
      }),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.order.mockReturnValue(query);
    query.limit.mockReturnValue(query);
    const client = {
      from: vi.fn().mockReturnValue(query),
    };

    const result = await createSupabaseDirectoryBackend(client).resolveFirstMemberActorForUser("user-1");

    expect(client.from).toHaveBeenCalledWith("actors");
    expect(query.select).toHaveBeenCalledWith("id, team_id");
    expect(query.eq).toHaveBeenCalledWith("user_id", "user-1");
    expect(query.eq).toHaveBeenCalledWith("actor_type", "member");
    expect(query.order).toHaveBeenCalledWith("created_at", { ascending: true });
    expect(query.order).toHaveBeenCalledWith("id", { ascending: true });
    expect(query.limit).toHaveBeenCalledWith(1);
    expect(query.maybeSingle).toHaveBeenCalled();
    expect(result).toEqual({ id: "actor-1", team_id: "team-1" });
  });
});
