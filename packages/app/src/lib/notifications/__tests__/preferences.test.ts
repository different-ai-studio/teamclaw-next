import { describe, it, expect } from 'vitest';
import { isInDndWindow } from '../preferences';

describe('isInDndWindow', () => {
  it('disabled when start is null', () => {
    expect(isInDndWindow({ dnd_start_min: null, dnd_end_min: null, dnd_tz: 'Asia/Shanghai' },
                         new Date())).toBe(false);
  });

  it('cross-midnight 22:00–07:00 Asia/Shanghai', () => {
    const prefs = { dnd_start_min: 1320, dnd_end_min: 420, dnd_tz: 'Asia/Shanghai' };
    expect(isInDndWindow(prefs, new Date('2026-05-17T15:30:00Z'))).toBe(true);  // 23:30 +08
    expect(isInDndWindow(prefs, new Date('2026-05-17T22:30:00Z'))).toBe(true);  // 06:30 +08
    expect(isInDndWindow(prefs, new Date('2026-05-17T04:00:00Z'))).toBe(false); // 12:00 +08
  });
});
