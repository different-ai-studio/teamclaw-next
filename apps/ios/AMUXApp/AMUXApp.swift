import SwiftUI
import SwiftData
import AMUXCore
import AMUXSharedUI
import Sentry
import Supabase

@main
struct AMUXApp: App {
    @UIApplicationDelegateAdaptor(PushAppDelegate.self) var pushDelegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var pairing = PairingManager()
    let modelContainer: ModelContainer

    init() {
        SentrySDK.start { options in
            options.dsn = "https://7551f3236520b84b27ec473a1d7c1480@o60909.ingest.us.sentry.io/4511233545011200"
            options.tracesSampleRate = 0.2
            options.enableAutoPerformanceTracing = true
            options.enableUIViewControllerTracing = true
            options.enableSwizzling = true
            // Sentry's Core Data swizzling spams "saveSpan is nil" once per
            // SwiftData save (every event the chat view streams). Disable it —
            // we don't have any direct Core Data usage to observe anyway.
            options.enableCoreDataTracing = false
            options.attachScreenshot = true
            options.attachViewHierarchy = true
            #if DEBUG
            options.debug = true
            options.environment = "development"
            #else
            options.environment = "production"
            #endif
        }

        // Explicit VersionedSchema + migration plan so SwiftData never falls
        // back to destructive migration on a field-shape change. See
        // AMUXSchema.swift for the upgrade checklist when models evolve.
        do {
            modelContainer = try AMUXModelContainerFactory.make()
        } catch {
            fatalError("Failed to initialise ModelContainer: \(error)")
        }
        NotificationCenter.default.addObserver(
            forName: .amuxApnsTokenReady, object: nil, queue: .main) { note in
            guard let hex = note.userInfo?["token"] as? String else { return }
            Task { await PushBootstrap.shared.handleApnsToken(hex) }
        }

        // Wire Supabase-backed push adapters. A dedicated client is built
        // from the same bundle config used by SupabaseAppOnboardingStore so
        // the token uploader, presence writer, and prefs API share the
        // authenticated session. The userIDProvider closure reads the
        // current session lazily — it resolves correctly both before and
        // after sign-in without a strong capture of the @State onboarding.
        if let config = try? SupabaseProjectConfiguration.fromMainBundle() {
            let pushClient = SupabaseClient(
                supabaseURL: config.url,
                supabaseKey: config.publishableKey
            )
            PushBootstrap.shared.registerWithSupabase(
                client: pushClient,
                userIDProvider: { [pushClient] in
                    pushClient.auth.currentSession?.user.id.uuidString.lowercased()
                }
            )
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView(pairing: pairing)
                .onOpenURL { url in handle(url) }
                // App-wide tint flips iOS 26 glass buttons, tab-bar selection,
                // toggle accents, and other system tinted surfaces to the Hai
                // Cinnabar accent without disturbing liquid-glass behaviour.
                .tint(Color.amux.cinnabar)
                .task { _ = await PushPermissionManager.requestIfUndetermined() }
        }
        .modelContainer(modelContainer)
        .onChange(of: scenePhase) { _, newPhase in
            switch newPhase {
            case .active:     PushBootstrap.shared.heartbeat?.enterForeground()
            case .background: PushBootstrap.shared.heartbeat?.enterBackground()
            default: break
            }
        }
    }

    private func handle(_ url: URL) {
        guard let scheme = url.scheme, ["teamclaw", "amux"].contains(scheme) else { return }

        switch url.host {
        case "invite":
            guard let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  let token = comps.queryItems?.first(where: { $0.name == "token" })?.value
            else { return }
            NotificationCenter.default.post(
                name: .amuxInviteTokenReceived, object: nil, userInfo: ["token": token]
            )
        case "auth-callback":
            NotificationCenter.default.post(
                name: .amuxAuthCallbackReceived, object: url
            )
        case "session":
            // teamclaw://session/<id>
            let sid = url.pathComponents.last ?? ""
            if !sid.isEmpty {
                NotificationCenter.default.post(
                    name: .amuxOpenSession, object: nil, userInfo: ["session_id": sid])
            }
        default:
            break
        }
    }
}
