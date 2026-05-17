import { supabase } from '@/lib/supabase-client';

export interface NotificationPrefs {
  enabled: boolean;
  dnd_start_min: number | null;
  dnd_end_min: number | null;
  dnd_tz: string;
}

export const DEFAULT_PREFS: NotificationPrefs = {
  enabled: true,
  dnd_start_min: null,
  dnd_end_min: null,
  dnd_tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
};

export async function loadPrefs(userId: string): Promise<NotificationPrefs> {
  const { data } = await supabase
    .from('notification_prefs').select('*')
    .eq('user_id', userId).maybeSingle();
  if (!data) return DEFAULT_PREFS;
  return {
    enabled: data.enabled,
    dnd_start_min: data.dnd_start_min,
    dnd_end_min: data.dnd_end_min,
    dnd_tz: data.dnd_tz ?? DEFAULT_PREFS.dnd_tz,
  };
}

export async function savePrefs(userId: string, p: NotificationPrefs): Promise<void> {
  await supabase.from('notification_prefs').upsert(
    { user_id: userId, ...p, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' },
  );
}

export async function setSessionMuted(
  userId: string, sessionId: string, muted: boolean
): Promise<void> {
  if (muted) {
    await supabase.from('session_mutes').upsert(
      { user_id: userId, session_id: sessionId }, { onConflict: 'user_id,session_id' },
    );
  } else {
    await supabase.from('session_mutes')
      .delete().eq('user_id', userId).eq('session_id', sessionId);
  }
}

export async function isSessionMuted(userId: string, sessionId: string): Promise<boolean> {
  const { data } = await supabase.from('session_mutes')
    .select('session_id').eq('user_id', userId).eq('session_id', sessionId).limit(1);
  return Boolean(data && data.length);
}

export function isInDndWindow(prefs: { dnd_start_min: number | null;
                                       dnd_end_min: number | null;
                                       dnd_tz: string },
                              now: Date): boolean {
  if (prefs.dnd_start_min == null || prefs.dnd_end_min == null) return false;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: prefs.dnd_tz, hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(now);
  const h = Number(parts.find(p => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find(p => p.type === 'minute')?.value ?? 0);
  const localMin = h * 60 + m;
  const a = prefs.dnd_start_min, b = prefs.dnd_end_min;
  if (a === b) return false;
  return a < b ? (localMin >= a && localMin < b)
               : (localMin >= a || localMin < b);
}
