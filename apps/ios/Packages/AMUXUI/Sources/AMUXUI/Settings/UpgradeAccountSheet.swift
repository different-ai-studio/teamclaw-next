import SwiftUI
import AMUXSharedUI
import AMUXCore

/// Presented from Settings when the current session is anonymous. Lets the
/// user attach a permanent identity (email or phone verification code, or
/// Apple) to keep the existing user_id and all team / actor / agent_member_access
/// rows.
struct UpgradeAccountSheet: View {
    @Bindable var coordinator: AppOnboardingCoordinator
    @Environment(\.dismiss) private var dismiss
    @State private var email = ""
    @State private var phone = "+86"
    @State private var code = ""
    @State private var method: UpgradeMethod = .email

    private enum UpgradeMethod: Hashable { case email, phone }

    /// True once a code has been sent (email or SMS) — switches to code entry.
    private var isCodeStep: Bool {
        coordinator.pendingEmailOTPEmail != nil || coordinator.pendingPhoneOTPPhone != nil
    }

    /// Whether the in-progress flow (entry or code step) is phone-based.
    private var isPhoneFlow: Bool {
        isCodeStep ? coordinator.pendingPhoneOTPPhone != nil : method == .phone
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Upgrade your account")
                            .font(.title2.bold())
                        Text(subtitle)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }

                    if isCodeStep {
                        codeStep
                    } else {
                        methodPicker
                        if method == .email {
                            emailStep
                        } else {
                            phoneStep
                        }
                    }

                    if let err = coordinator.errorMessage {
                        Text(err).font(.footnote).foregroundStyle(Color.amux.cinnabarDeep)
                    }

                    if !isCodeStep {
                        appleUpgradeSection
                    }

                    Text(isPhoneFlow
                         ? "After upgrading, sign in with the same phone number next time you launch Teamclaw."
                         : "After upgrading, sign in with the same email next time you launch Teamclaw.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(24)
            }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Cancel") {
                        resetPending()
                        dismiss()
                    }
                }
            }
        }
    }

    private var subtitle: String {
        if let pendingPhone = coordinator.pendingPhoneOTPPhone {
            return "Enter the 6-digit code we texted to \(pendingPhone)."
        }
        if let pendingEmail = coordinator.pendingEmailOTPEmail {
            return "Enter the 6-digit code we emailed to \(pendingEmail)."
        }
        return "Attach a permanent identity so you don't lose access to this workspace."
    }

    // MARK: - Method picker

    private var methodPicker: some View {
        Picker("Upgrade method", selection: $method) {
            Text("Email").tag(UpgradeMethod.email)
            Text("Phone").tag(UpgradeMethod.phone)
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("upgrade.methodPicker")
    }

    // MARK: - Step 1: email entry

    @ViewBuilder private var emailStep: some View {
        VStack(spacing: 12) {
            TextField("Email", text: $email)
                .textContentType(.emailAddress)
                .keyboardType(.emailAddress)
                .autocapitalization(.none)
                .autocorrectionDisabled()
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .liquidGlass(in: RoundedRectangle(cornerRadius: 16), interactive: false)
                .accessibilityIdentifier("upgrade.emailField")
        }

        sendCodeButton(enabled: !email.isEmpty) {
            Task { await coordinator.sendUpgradeEmailOTP(email: email) }
        }
    }

    // MARK: - Step 1: phone entry

    @ViewBuilder private var phoneStep: some View {
        VStack(spacing: 12) {
            TextField("Phone number", text: $phone)
                .textContentType(.telephoneNumber)
                .keyboardType(.phonePad)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .liquidGlass(in: RoundedRectangle(cornerRadius: 16), interactive: false)
                .accessibilityIdentifier("upgrade.phoneField")
        }

        sendCodeButton(enabled: phone.count > 4) {
            Task { await coordinator.sendUpgradePhoneOTP(phone: phone) }
        }
    }

    private func sendCodeButton(enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                if coordinator.isBusy { ProgressView().progressViewStyle(.circular).tint(.white) }
                Text("Send code").fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
        }
        .glassProminentButtonStyle()
        .disabled(coordinator.isBusy || !enabled)
        .accessibilityIdentifier("upgrade.sendCodeButton")
    }

    // MARK: - Step 2: code entry

    @ViewBuilder private var codeStep: some View {
        VStack(spacing: 12) {
            TextField("6-digit code", text: $code)
                .textContentType(.oneTimeCode)
                .keyboardType(.numberPad)
                .onChange(of: code) { _, newValue in
                    let digits = newValue.filter(\.isNumber)
                    code = String(digits.prefix(6))
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .liquidGlass(in: RoundedRectangle(cornerRadius: 16), interactive: false)
                .accessibilityIdentifier("upgrade.codeField")
        }

        Button {
            Task {
                if let pendingPhone = coordinator.pendingPhoneOTPPhone {
                    await coordinator.verifyUpgradePhoneOTP(phone: pendingPhone, token: code)
                } else {
                    await coordinator.verifyUpgradeEmailOTP(
                        email: coordinator.pendingEmailOTPEmail ?? email,
                        token: code
                    )
                }
                if !coordinator.isAnonymous {
                    resetPending()
                    dismiss()
                }
            }
        } label: {
            HStack {
                if coordinator.isBusy { ProgressView().progressViewStyle(.circular).tint(.white) }
                Text("Verify").fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
        }
        .glassProminentButtonStyle()
        .disabled(coordinator.isBusy || code.count != 6)
        .accessibilityIdentifier("upgrade.verifyButton")

        Button(coordinator.pendingPhoneOTPPhone != nil ? "Use a different number" : "Use a different email") {
            code = ""
            resetPending()
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity)
    }

    // MARK: - Apple option

    @ViewBuilder private var appleUpgradeSection: some View {
        HStack {
            Rectangle().frame(height: 1).foregroundStyle(.separator)
            Text("or").font(.footnote).foregroundStyle(.secondary)
            Rectangle().frame(height: 1).foregroundStyle(.separator)
        }

        Button {
            Task {
                await coordinator.upgradeWithApple()
                if !coordinator.isAnonymous {
                    dismiss()
                }
            }
        } label: {
            Label("Upgrade with Apple", systemImage: "applelogo")
                .fontWeight(.semibold)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
        }
        .glassButtonStyle()
        .disabled(coordinator.isBusy)
    }

    private func resetPending() {
        coordinator.resetPendingEmailOTP()
        coordinator.resetPendingPhoneOTP()
    }
}
