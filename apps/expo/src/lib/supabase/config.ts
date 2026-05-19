export type ExpoSupabaseConfig = {
  url: string;
  publishableKey: string;
};

export function getSupabaseConfig(): ExpoSupabaseConfig {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();

  if (!url || !publishableKey) {
    throw new Error("Missing Expo Supabase configuration");
  }

  return {
    url,
    publishableKey,
  };
}
