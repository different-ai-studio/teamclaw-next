import { describe, expect, it } from "vitest";

import {
  canManageAuthorizedHumans,
  canRemoveActor,
} from "../features/actors/actor-management";

describe("actor management", () => {
  it("allows owners and admins to remove other actors", () => {
    expect(
      canRemoveActor({
        actorId: "actor-2",
        currentMemberActorId: "actor-1",
        currentTeamRole: "owner",
      }),
    ).toBe(true);
    expect(
      canRemoveActor({
        actorId: "actor-2",
        currentMemberActorId: "actor-1",
        currentTeamRole: "admin",
      }),
    ).toBe(true);
  });

  it("blocks self-removal and non-admin roles", () => {
    expect(
      canRemoveActor({
        actorId: "actor-1",
        currentMemberActorId: "actor-1",
        currentTeamRole: "owner",
      }),
    ).toBe(false);
    expect(
      canRemoveActor({
        actorId: "actor-2",
        currentMemberActorId: "actor-1",
        currentTeamRole: "member",
      }),
    ).toBe(false);
  });

  it("only lets an agent owner manage authorized humans", () => {
    expect(
      canManageAuthorizedHumans({
        actorType: "agent",
        ownerMemberId: "member-1",
        currentMemberActorId: "member-1",
      }),
    ).toBe(true);
    expect(
      canManageAuthorizedHumans({
        actorType: "agent",
        ownerMemberId: "member-2",
        currentMemberActorId: "member-1",
      }),
    ).toBe(false);
    expect(
      canManageAuthorizedHumans({
        actorType: "member",
        ownerMemberId: "member-1",
        currentMemberActorId: "member-1",
      }),
    ).toBe(false);
  });
});
