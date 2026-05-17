import Foundation
import UIKit
import AMUXCore

@MainActor
final class PushBootstrap {
    static let shared = PushBootstrap()

    private(set) var service: PushService?
    private(set) var heartbeat: PresenceHeartbeat?
    private(set) var preferencesAPI: PushPreferencesAPI?

    func register(uploader: PushTokenUploader,
                  presenceWriter: PresenceWriter,
                  preferencesAPI: PushPreferencesAPI,
                  userIDProvider: @escaping @Sendable () -> String?) {
        let bundle = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        let deviceID = UIDevice.current.identifierForVendor?.uuidString ?? "unknown"
        service = PushService(
            uploader: uploader,
            userIDProvider: userIDProvider,
            deviceIDProvider: { [deviceID] in deviceID },
            appVersionProvider: { [bundle] in bundle }
        )
        heartbeat = PresenceHeartbeat(writer: presenceWriter, deviceID: deviceID)
        self.preferencesAPI = preferencesAPI
    }

    func handleApnsToken(_ hex: String) async {
        guard let svc = service else { return }
        try? await svc.uploadToken(hex)
    }
}
