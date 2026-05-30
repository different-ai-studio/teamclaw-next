import Foundation

// Supabase-SDK-free configuration + auth-outcome types shared by the Cloud API
// layer. The Cloud API still resolves the upstream Supabase URL/anon key (FC
// forwards the caller's bearer to Supabase), and the onboarding store reports
// sign-up outcomes — neither needs the Supabase SDK, so these live outside the
// (now-deleted) SupabaseAppOnboardingStore.

public enum SignUpOutcome: Error, LocalizedError {
    case emailAlreadyInUse
    case emailConfirmationRequired

    public var errorDescription: String? {
        switch self {
        case .emailAlreadyInUse:
            return "This email is already registered. Try signing in instead."
        case .emailConfirmationRequired:
            return "Check your inbox — we sent you a confirmation link."
        }
    }
}

/// Persists Supabase URL + publishable key overrides in UserDefaults. Falls
/// back to the bundled `services.default.json` when nothing is stored.
/// Changing values requires an app relaunch.
public enum SupabaseServerStore {
    public static let urlKey = "teamclaw_supabase_url"
    public static let keyKey = "teamclaw_supabase_key"
    private static let legacyURLKey = "amux_supabase_url"
    private static let legacyKeyKey = "amux_supabase_key"

    public static func currentURL() -> String {
        storedURL(in: .standard) ?? SharedDefaults.services.supabaseUrl
    }

    public static func currentKey() -> String {
        storedKey(in: .standard) ?? SharedDefaults.services.supabaseAnonKey
    }

    public static func save(url: String, key: String) {
        let d = UserDefaults.standard
        d.set(url.trimmingCharacters(in: .whitespacesAndNewlines), forKey: urlKey)
        d.set(key.trimmingCharacters(in: .whitespacesAndNewlines), forKey: keyKey)
    }

    public static func storedURL(in defaults: UserDefaults) -> String? {
        defaults.string(forKey: urlKey) ?? defaults.string(forKey: legacyURLKey)
    }

    public static func storedKey(in defaults: UserDefaults) -> String? {
        defaults.string(forKey: keyKey) ?? defaults.string(forKey: legacyKeyKey)
    }
}
