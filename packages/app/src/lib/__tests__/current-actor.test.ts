import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCurrentMemberActorId } from "../current-actor";

const supabaseFrom = vi.fn();

vi.mock("@/lib/supabase-client", () => ({
  supabase: {
    from: (...args: unknown[]) => supabaseFrom(...args),
  },
}));

beforeEach(() => {
  supabaseFrom.mockReset();
});

describe("resolveCurrentMemberActorId", () => {
  it("uses current team member hint without querying Supabase", async () => {
    await expect(
      resolveCurrentMemberActorId("team-1", "user-1", {
        currentTeamId: "team-1",
        currentMemberId: "actor-self",
      }),
    ).resolves.toBe("actor-self");

    expect(supabaseFrom).not.toHaveBeenCalled();
  });

  it("falls back to actor_directory before actors", async () => {
    supabaseFrom.mockImplementation((table: string) => {
      if (table === "actor_directory") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  limit: () => Promise.resolve({
                    data: [{ id: "actor-directory-self" }],
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    });

    await expect(
      resolveCurrentMemberActorId("team-1", "user-1"),
    ).resolves.toBe("actor-directory-self");

    expect(supabaseFrom).toHaveBeenCalledWith("actor_directory");
  });

  it("falls back to actors when actor_directory has no row", async () => {
    supabaseFrom.mockImplementation((table: string) => {
      if (table === "actor_directory") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  limit: () => Promise.resolve({ data: [], error: null }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "actors") {
        return {
          select: () => ({
            eq: () => Promise.resolve({
              data: [
                { id: "other", team_id: "team-2" },
                { id: "actor-self", team_id: "team-1" },
              ],
              error: null,
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    });

    await expect(
      resolveCurrentMemberActorId("team-1", "user-1"),
    ).resolves.toBe("actor-self");
  });
});
