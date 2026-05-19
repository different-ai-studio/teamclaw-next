import { describe, expect, it, vi } from "vitest";

import type { BootstrapResult, TeamSummary } from "../features/onboarding/onboarding-types";

function createQueryMock<T>(result: Promise<T>) {
  const builder = {
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    single: vi.fn().mockReturnThis(),
    then: result.then.bind(result),
    catch: result.catch.bind(result),
    finally: result.finally.bind(result),
  };

  return builder;
}

describe("createOnboardingApi", () => {
  it("loadBootstrap returns null team when user has no member actors", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");

    const actorQuery = createQueryMock(Promise.resolve({ data: [], error: null }));
    const from = vi.fn((table: string) => {
      if (table === "actors") {
        return actorQuery;
      }

      throw new Error(`unexpected table: ${table}`);
    });

    const client = {
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: {
            session: {
              user: {
                id: "user-1",
                is_anonymous: true,
              },
            },
          },
          error: null,
        }),
      },
      from,
    } as any;

    const api = createOnboardingApi(client);

    await expect(api.loadBootstrap()).resolves.toEqual({
      isAnonymous: true,
      team: null,
      memberActorId: null,
    } satisfies BootstrapResult);
    expect(actorQuery.select).toHaveBeenCalledWith("id");
    expect(actorQuery.eq).toHaveBeenNthCalledWith(1, "user_id", "user-1");
    expect(actorQuery.eq).toHaveBeenNthCalledWith(2, "actor_type", "member");
  });

  it("loadBootstrap returns first team membership as TeamSummary", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");

    const memberships = [
      {
        role: "owner",
        teams: {
          id: "team-1",
          name: "Team Claw",
          slug: "team-claw",
        },
        member_id: "actor-1",
      },
      {
        role: "member",
        teams: {
          id: "team-2",
          name: "Ignored",
          slug: "ignored",
        },
        member_id: "actor-2",
      },
    ];

    const actorQuery = createQueryMock(Promise.resolve({
      data: [{ id: "actor-1" }, { id: "actor-2" }],
      error: null,
    }));
    const membershipQuery = createQueryMock(Promise.resolve({
      data: memberships,
      error: null,
    }));
    const from = vi.fn((table: string) => {
      if (table === "actors") {
        return actorQuery;
      }
      if (table === "team_members") {
        return membershipQuery;
      }
      throw new Error(`unexpected table: ${table}`);
    });

    const client = {
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: {
            session: {
              user: {
                id: "user-1",
                is_anonymous: false,
              },
            },
          },
          error: null,
        }),
      },
      from,
    } as any;

    const api = createOnboardingApi(client);

    await expect(api.loadBootstrap()).resolves.toEqual({
      isAnonymous: false,
      memberActorId: "actor-1",
      team: {
        id: "team-1",
        name: "Team Claw",
        slug: "team-claw",
        role: "owner",
      } satisfies TeamSummary,
    } satisfies BootstrapResult);
    expect(actorQuery.eq).toHaveBeenNthCalledWith(1, "user_id", "user-1");
    expect(actorQuery.eq).toHaveBeenNthCalledWith(2, "actor_type", "member");
    expect(membershipQuery.select).toHaveBeenCalledWith("member_id, role, teams!inner(id, name, slug)");
    expect(membershipQuery.in).toHaveBeenCalledWith("member_id", ["actor-1", "actor-2"]);
  });

  it("sendEmailOTP resolves with pendingEmail", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");

    const signInWithOtp = vi.fn().mockResolvedValue({ data: {}, error: null });
    const client = {
      auth: {
        signInWithOtp,
      },
    } as any;

    const api = createOnboardingApi(client);

    await expect(api.sendEmailOTP("person@example.com")).resolves.toEqual({
      pendingEmail: "person@example.com",
    });
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "person@example.com",
      options: {
        shouldCreateUser: true,
      },
    });
  });

  it("verifyOTP calls verifyOtp with email token and email type", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");

    const verifyOtp = vi.fn().mockResolvedValue({ data: {}, error: null });
    const client = {
      auth: {
        verifyOtp,
      },
    } as any;

    const api = createOnboardingApi(client);

    await expect(api.verifyOTP("person@example.com", "123456")).resolves.toEqual({});
    expect(verifyOtp).toHaveBeenCalledWith({
      email: "person@example.com",
      token: "123456",
      type: "email",
    });
  });

  it("createTeam uses the create_team RPC and returns TeamSummary", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");

    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          team_id: "team-1",
          team_name: "Team Claw",
          team_slug: "team-claw",
          member_id: "member-1",
          role: "owner",
          workspace_id: "workspace-1",
          workspace_name: "Workspace",
        },
      ],
      error: null,
    });
    const client = {
      auth: {},
      rpc,
    } as any;

    const api = createOnboardingApi(client);

    await expect(api.createTeam("Team Claw")).resolves.toEqual({
      id: "team-1",
      name: "Team Claw",
      slug: "team-claw",
      role: "owner",
    } satisfies TeamSummary);
    expect(rpc).toHaveBeenCalledWith("create_team", { p_name: "Team Claw" });
  });
});
