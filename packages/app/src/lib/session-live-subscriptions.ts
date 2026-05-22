import { mqttSubscribe } from "@/lib/mqtt-bridge";

export const subscribedSessionTopics = new Set<string>();

const subscribedTeamSessionTopics = new Set<string>();

function teamSessionLiveTopic(teamId: string): string {
  return `amux/${teamId}/session/+/live`;
}

function sessionLiveTopic(teamId: string, sessionId: string): string {
  return `amux/${teamId}/session/${sessionId}/live`;
}

export function hasTeamSessionLiveSubscription(teamId: string): boolean {
  return subscribedTeamSessionTopics.has(teamSessionLiveTopic(teamId));
}

export async function ensureTeamSessionLiveSubscribed(teamId: string): Promise<void> {
  const topic = teamSessionLiveTopic(teamId);
  if (subscribedTeamSessionTopics.has(topic)) return;

  subscribedTeamSessionTopics.add(topic);
  try {
    await mqttSubscribe(topic);
  } catch (e) {
    subscribedTeamSessionTopics.delete(topic);
    throw e;
  }
}

export async function ensureSessionLiveSubscribed(
  teamId: string,
  sessionId: string,
): Promise<void> {
  if (hasTeamSessionLiveSubscription(teamId)) return;

  const topic = sessionLiveTopic(teamId, sessionId);
  if (subscribedSessionTopics.has(topic)) return;

  subscribedSessionTopics.add(topic);
  try {
    await mqttSubscribe(topic);
  } catch (e) {
    subscribedSessionTopics.delete(topic);
    throw e;
  }
}

export function resetSessionLiveSubscriptionStateForTests(): void {
  subscribedSessionTopics.clear();
  subscribedTeamSessionTopics.clear();
}
