import { useEffect, useRef, useState } from "react";
import { adaptiveCharsPerFrame } from "@/stores/streaming";

/**
 * Gradually reveals `targetText` while `active` (v2 live bubble / thinking).
 * Matches the legacy session typewriter cadence in streaming.ts.
 */
export function useStreamRevealText(targetText: string, active: boolean): string {
  const [displayed, setDisplayed] = useState(() => (active ? "" : targetText));
  const displayedRef = useRef(active ? "" : targetText);
  const targetRef = useRef(targetText);
  const rafRef = useRef<number | null>(null);

  targetRef.current = targetText;

  const stopAnimation = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  useEffect(() => {
    if (!active) {
      stopAnimation();
      displayedRef.current = targetText;
      setDisplayed(targetText);
      return;
    }

    if (targetText.length < displayedRef.current.length) {
      stopAnimation();
      displayedRef.current = targetText;
      setDisplayed(targetText);
      return;
    }

    const tick = () => {
      const target = targetRef.current;
      const revealed = displayedRef.current;
      const backlog = target.length - revealed.length;
      if (backlog <= 0) {
        rafRef.current = null;
        return;
      }

      const chars = adaptiveCharsPerFrame(backlog);
      const next = target.slice(0, revealed.length + chars);
      displayedRef.current = next;
      setDisplayed(next);
      rafRef.current = requestAnimationFrame(tick);
    };

    if (targetText.length > displayedRef.current.length && rafRef.current === null) {
      rafRef.current = requestAnimationFrame(tick);
    }

    return stopAnimation;
  }, [targetText, active]);

  return active ? displayed : targetText;
}
