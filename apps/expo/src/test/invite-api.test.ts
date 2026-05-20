import { describe, expect, it, vi } from "vitest";

import { createInviteApi, parseInviteToken } from "../features/onboarding/invite-api";

describe("parseInviteToken", () => {
  it("returns null for nullish / empty inputs", () => {
    expect(parseInviteToken(null)).toBeNull();
    expect(parseInviteToken(undefined)).toBeNull();
    expect(parseInviteToken("   ")).toBeNull();
  });

  it("returns null for non-URL strings", () => {
    expect(parseInviteToken("not a url")).toBeNull();
  });

  it("returns null when the URL is for a different action", () => {
    expect(parseInviteToken("teamclaw://session/abc-123")).toBeNull();
  });

  it("extracts the token from the path form (teamclaw://invite/<token>)", () => {
    expect(parseInviteToken("teamclaw://invite/tok-abc")).toBe("tok-abc");
  });

  it("extracts the token from the query form (teamclaw://invite?token=<token>)", () => {
    expect(parseInviteToken("teamclaw://invite?token=tok-xyz")).toBe("tok-xyz");
  });

  it("prefers the query token when both are present", () => {
    expect(parseInviteToken("teamclaw://invite/path-tok?token=query-tok")).toBe(
      "query-tok",
    );
  });

  it("accepts /invite/<token> with no host (https universal link form)", () => {
    expect(parseInviteToken("https://app.teamclaw.tech/invite/tok-https")).toBe(
      "tok-https",
    );
  });
});

describe("createInviteApi.claim", () => {
  it("throws for an empty token without hitting the RPC", async () => {
    const rpc = vi.fn();
    const client = { rpc } as unknown as Parameters<typeof createInviteApi>[0];
    const api = createInviteApi(client);
    await expect(api.claim("  ")).rejects.toThrow(/empty/i);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns the mapped ClaimResult on success", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          actor_id: "actor-1",
          team_id: "team-1",
          actor_type: "member",
          display_name: "Alice",
          refresh_token: "rt-1",
        },
      ],
      error: null,
    });
    const client = { rpc } as unknown as Parameters<typeof createInviteApi>[0];
    const api = createInviteApi(client);
    await expect(api.claim("tok")).resolves.toEqual({
      actorId: "actor-1",
      teamId: "team-1",
      actorType: "member",
      displayName: "Alice",
      refreshToken: "rt-1",
    });
    expect(rpc).toHaveBeenCalledWith("claim_team_invite", { token: "tok" });
  });

  it("accepts a single-row response (not wrapped in an array)", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        actor_id: "actor-2",
        team_id: "team-2",
        actor_type: "agent",
        display_name: "Bob",
        refresh_token: null,
      },
      error: null,
    });
    const client = { rpc } as unknown as Parameters<typeof createInviteApi>[0];
    const api = createInviteApi(client);
    const result = await api.claim("tok-2");
    expect(result.actorId).toBe("actor-2");
    expect(result.refreshToken).toBeNull();
  });

  it("rejects when the RPC surfaces an error", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "token expired" },
    });
    const client = { rpc } as unknown as Parameters<typeof createInviteApi>[0];
    const api = createInviteApi(client);
    await expect(api.claim("tok")).rejects.toThrow(/token expired/);
  });

  it("rejects when the RPC returns no row", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    const client = { rpc } as unknown as Parameters<typeof createInviteApi>[0];
    const api = createInviteApi(client);
    await expect(api.claim("tok")).rejects.toThrow(/no actor/i);
  });
});
