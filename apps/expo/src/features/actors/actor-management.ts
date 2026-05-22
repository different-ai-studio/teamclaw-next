export function canRemoveActor({
  actorId,
  currentMemberActorId,
  currentTeamRole,
}: {
  actorId: string | null | undefined;
  currentMemberActorId: string | null | undefined;
  currentTeamRole: string | null | undefined;
}): boolean {
  if (!actorId || !currentMemberActorId) return false;
  if (actorId === currentMemberActorId) return false;
  return currentTeamRole === "owner" || currentTeamRole === "admin";
}

export function canManageAuthorizedHumans({
  actorType,
  ownerMemberId,
  currentMemberActorId,
}: {
  actorType: string | null | undefined;
  ownerMemberId: string | null | undefined;
  currentMemberActorId: string | null | undefined;
}): boolean {
  return actorType === "agent" && Boolean(ownerMemberId) && ownerMemberId === currentMemberActorId;
}
