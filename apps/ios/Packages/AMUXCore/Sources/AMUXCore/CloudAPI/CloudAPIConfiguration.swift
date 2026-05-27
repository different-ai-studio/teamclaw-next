import Foundation

public enum BackendProviderKind: String, Sendable {
    case supabase
    case cloudAPI = "cloud_api"
}

public struct CloudAPIConfiguration: Equatable, Sendable {
    public let baseURL: URL
    public let supabaseURL: URL
    public let supabaseAnonKey: String

    public init(baseURL: URL, supabaseURL: URL, supabaseAnonKey: String) {
        self.baseURL = baseURL
        self.supabaseURL = supabaseURL
        self.supabaseAnonKey = supabaseAnonKey
    }
}

public enum CloudAPIConfigurationStore {
    public static let backendKindKey = "teamclaw_backend_kind"
    public static let cloudAPIURLKey = "teamclaw_cloud_api_url"

    public static func backendKind(in defaults: UserDefaults = .standard) -> BackendProviderKind {
        guard let raw = defaults.string(forKey: backendKindKey),
              let kind = BackendProviderKind(rawValue: raw) else {
            return .supabase
        }
        return kind
    }

    public static func storedCloudAPIURL(in defaults: UserDefaults = .standard) -> String? {
        let value = defaults.string(forKey: cloudAPIURLKey)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return value?.isEmpty == false ? value : SharedDefaults.services.cloudApiUrl
    }

    public static func configuration(in defaults: UserDefaults = .standard) -> CloudAPIConfiguration? {
        guard backendKind(in: defaults) == .cloudAPI,
              let rawCloudURL = storedCloudAPIURL(in: defaults),
              let cloudURL = URL(string: rawCloudURL),
              let supabaseURL = URL(string: SupabaseServerStore.storedURL(in: defaults) ?? SharedDefaults.services.supabaseUrl) else {
            return nil
        }

        return CloudAPIConfiguration(
            baseURL: cloudURL,
            supabaseURL: supabaseURL,
            supabaseAnonKey: SupabaseServerStore.storedKey(in: defaults) ?? SharedDefaults.services.supabaseAnonKey
        )
    }
}
