import { applySessionRuntimeModel } from "@/lib/session-runtime-model";

export interface SyncSessionRuntimeModelIfNeededArgs {
  sessionId: string | null;
  modelId: string | null;
  lastAppliedKey: string | null;
  apply?: typeof applySessionRuntimeModel;
}

function syncKeyFor(sessionId: string | null, modelId: string | null): string | null {
  const sid = sessionId?.trim() ?? "";
  const mid = modelId?.trim() ?? "";
  if (!sid || !mid) return null;
  return `${sid}::${mid}`;
}

export async function syncSessionRuntimeModelIfNeeded(
  args: SyncSessionRuntimeModelIfNeededArgs,
): Promise<string | null> {
  const nextKey = syncKeyFor(args.sessionId, args.modelId);
  if (!nextKey) return null;
  if (nextKey === args.lastAppliedKey) return nextKey;

  const apply = args.apply ?? applySessionRuntimeModel;
  await apply({
    sessionId: args.sessionId,
    agentActorIds: [],
    modelId: args.modelId!,
  });
  return nextKey;
}
