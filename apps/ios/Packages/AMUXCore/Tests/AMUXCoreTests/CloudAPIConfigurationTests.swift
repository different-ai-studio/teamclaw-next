import Foundation
import Testing
@testable import AMUXCore

@Suite("Cloud API configuration")
struct CloudAPIConfigurationTests {
    @Test
    func defaultsToSupabaseBackendKind() {
        let defaults = UserDefaults(suiteName: "CloudAPIConfigurationTests.defaults")!
        defaults.removePersistentDomain(forName: "CloudAPIConfigurationTests.defaults")

        #expect(CloudAPIConfigurationStore.backendKind(in: defaults) == .supabase)
        #expect(CloudAPIConfigurationStore.configuration(in: defaults) == nil)
    }

    @Test
    func buildsCloudAPIConfigurationWhenStored() throws {
        let suite = "CloudAPIConfigurationTests.cloud"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        defaults.set("cloud_api", forKey: CloudAPIConfigurationStore.backendKindKey)
        defaults.set("https://fc.example.com", forKey: CloudAPIConfigurationStore.cloudAPIURLKey)
        defaults.set("https://project.supabase.co", forKey: SupabaseServerStore.urlKey)
        defaults.set("anon-key", forKey: SupabaseServerStore.keyKey)

        let config = try #require(CloudAPIConfigurationStore.configuration(in: defaults))
        #expect(config.baseURL.absoluteString == "https://fc.example.com")
        #expect(config.supabaseURL.absoluteString == "https://project.supabase.co")
        #expect(config.supabaseAnonKey == "anon-key")
    }
}
