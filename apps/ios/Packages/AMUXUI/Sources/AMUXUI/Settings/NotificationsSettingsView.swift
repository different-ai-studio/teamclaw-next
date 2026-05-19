import SwiftUI
import AMUXCore

@MainActor
public struct NotificationsSettingsView: View {
    @State private var prefs = NotificationPrefs()
    @State private var loading = true
    let api: any PushPreferencesAPI

    public init(api: any PushPreferencesAPI) {
        self.api = api
    }

    public var body: some View {
        Form {
            Section {
                Toggle("Enable push notifications", isOn: $prefs.enabled)
                    .onChange(of: prefs.enabled) { _, _ in
                        Task { try? await api.save(prefs) }
                    }
            }

            Section("Do Not Disturb") {
                Toggle("Enabled", isOn: Binding(
                    get: { prefs.dndStartMin != nil },
                    set: { on in
                        if on {
                            if prefs.dndStartMin == nil { prefs.dndStartMin = 22 * 60 }
                            if prefs.dndEndMin == nil   { prefs.dndEndMin   = 7  * 60 }
                        } else {
                            prefs.dndStartMin = nil
                            prefs.dndEndMin   = nil
                        }
                        Task { try? await api.save(prefs) }
                    }
                ))

                if prefs.dndStartMin != nil {
                    DatePicker("Start", selection: bindMin($prefs.dndStartMin),
                               displayedComponents: .hourAndMinute)
                        .onChange(of: prefs.dndStartMin) { _, _ in
                            Task { try? await api.save(prefs) }
                        }

                    DatePicker("End", selection: bindMin($prefs.dndEndMin),
                               displayedComponents: .hourAndMinute)
                        .onChange(of: prefs.dndEndMin) { _, _ in
                            Task { try? await api.save(prefs) }
                        }
                }
            }
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.large)
        .task {
            if loading {
                prefs = (try? await api.load()) ?? NotificationPrefs()
                loading = false
            }
        }
    }

    private func bindMin(_ source: Binding<Int?>) -> Binding<Date> {
        Binding(
            get: {
                let m = source.wrappedValue ?? 0
                return Calendar.current.date(
                    bySettingHour: m / 60, minute: m % 60, second: 0, of: Date()
                ) ?? Date()
            },
            set: { newDate in
                let comps = Calendar.current.dateComponents([.hour, .minute], from: newDate)
                source.wrappedValue = (comps.hour ?? 0) * 60 + (comps.minute ?? 0)
            }
        )
    }
}
