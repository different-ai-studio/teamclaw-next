import { beforeEach, describe, expect, it, vi } from "vitest";

const subscribeMock = vi.fn();

vi.mock("@/lib/mqtt-bridge", () => ({
  mqttSubscribe: subscribeMock,
}));

const {
  ensureSessionLiveSubscribed,
  ensureTeamSessionLiveSubscribed,
  resetSessionLiveSubscriptionStateForTests,
} = await import("./session-live-subscriptions");

beforeEach(() => {
  subscribeMock.mockReset();
  resetSessionLiveSubscriptionStateForTests();
});

describe("session live subscriptions", () => {
  it("subscribes to team wildcard live topic and skips overlapping session subscriptions", async () => {
    subscribeMock.mockResolvedValue(undefined);

    await ensureTeamSessionLiveSubscribed("team-1");
    await ensureSessionLiveSubscribed("team-1", "session-1");

    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock).toHaveBeenCalledWith("amux/team-1/session/+/live");
  });
});
