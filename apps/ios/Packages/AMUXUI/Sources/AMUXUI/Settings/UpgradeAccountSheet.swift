import SwiftUI
import AMUXSharedUI
import AMUXCore

/// Presented from Settings when the current session is anonymous. Lets the
/// user attach a permanent identity (email verification code or Apple) to keep
/// the existing user_id and all team / actor / agent_member_access rows.
struct UpgradeAccountSheet: View {
    @Bindable var coordinator: AppOnboardingCoordinator
    @Environment(\.dismiss) private var dismiss
    @State private var email = ""
    @State private var code = ""

    /// True once a code has been emailed — switches the sheet to code entry.
    private var isCodeStep: Bool { coordinator.pendingEmailOTPEmail != nil }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Upgrade your account")
                            .font(.title2.bold())
                        Text(isCodeStep
                             ? "Enter the 6-digit code we emailed to \(coordinator.pendingEmailOTPEmail ?? email)."
                             : "Attach a permanent identity so you don't lose access to this workspace.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }

                    if isCodeStep {
                        codeStep
                    } else {
                        emailStep
                    }

                    if let err = coordinator.errorMessage {
                        Text(err).font(.footnote).foregroundStyle(Color.amux.cinnabarDeep)
                    }

                    if !isCodeStep {
                        appleUpgradeSection
                    }

                    Text("After upgrading, sign in with the same email next time you launch Teamclaw.")
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
                        coordinator.resetPendingEmailOTP()
                        dismiss()
                    }
                }
            }
        }
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

        Button {
            Task { await coordinator.sendUpgradeEmailOTP(email: email) }
        } label: {
            HStack {
                if coordinator.isBusy { ProgressView().progressViewStyle(.circular).tint(.white) }
                Text("Send code").fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
        }
        .glassProminentButtonStyle()
        .disabled(coordinator.isBusy || email.isEmpty)
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
                await coordinator.verifyUpgradeEmailOTP(
                    email: coordinator.pendingEmailOTPEmail ?? email,
                    token: code
                )
                if !coordinator.isAnonymous {
                    coordinator.resetPendingEmailOTP()
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

        Button("Use a different email") {
            code = ""
            coordinator.resetPendingEmailOTP()
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
}
