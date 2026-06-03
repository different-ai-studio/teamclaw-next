import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STREAM_AWAITING_NEXT_EVENT_MS,
  useStreamAwaitingNextEvent,
} from "@/hooks/useStreamAwaitingNextEvent";

describe("useStreamAwaitingNextEvent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false while inactive", () => {
    const { result } = renderHook(() => useStreamAwaitingNextEvent(false, Date.now()));
    expect(result.current).toBe(false);
  });

  it("becomes true after idleMs without a lastUpdate bump", () => {
    const { result, rerender } = renderHook(
      ({ lastUpdate }) => useStreamAwaitingNextEvent(true, lastUpdate),
      { initialProps: { lastUpdate: 1000 } },
    );
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(STREAM_AWAITING_NEXT_EVENT_MS);
    });
    expect(result.current).toBe(true);

    rerender({ lastUpdate: 2000 });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(STREAM_AWAITING_NEXT_EVENT_MS);
    });
    expect(result.current).toBe(true);
  });

  it("clears when the stream becomes inactive", () => {
    const { result, rerender } = renderHook(
      ({ active, lastUpdate }) => useStreamAwaitingNextEvent(active, lastUpdate),
      { initialProps: { active: true, lastUpdate: 1000 } },
    );
    act(() => {
      vi.advanceTimersByTime(STREAM_AWAITING_NEXT_EVENT_MS);
    });
    expect(result.current).toBe(true);
    rerender({ active: false, lastUpdate: 1000 });
    expect(result.current).toBe(false);
  });
});
