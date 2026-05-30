import SwiftUI
import AuthenticationServices
import AMUXSharedUI
import AMUXCore

struct LoginView: View {
    @Bindable var coordinator: AppOnboardingCoordinator
    @State private var email = ""
    @State private var code = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                header

                if coordinator.pendingEmailOTPEmail != nil {
                    codeEntrySection
                } else {
                    emailEntrySection
                }

                if let err = coordinator.errorMessage {
                    Text(err)
                        .font(.footnote)
                        .foregroundStyle(Color.amux.cinnabarDeep)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                divider

                socialButtons
            }
            .padding(.horizontal, 24)
            .padding(.top, 72)
            .padding(.bottom, 36)
        }
        .background(Color.amux.mist)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(coordinator.pendingEmailOTPEmail != nil ? "Enter the code" : "Sign in")
                .font(.amuxSerif(38, weight: .regular))
                .foregroundStyle(Color.amux.onyx)
            Text(coordinator.pendingEmailOTPEmail != nil
                 ? "Check your inbox for a 6-digit code."
                 : "We'll email you a 6-digit code.")
                .font(.body)
                .foregroundStyle(Color.amux.basalt)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Email entry (step 1)

    private var emailEntrySection: some View {
        VStack(spacing: 12) {
            authField {
                TextField("Email", text: $email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .autocapitalization(.none)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("login.emailField")
            }

            primaryButton(title: "Send code", enabled: !email.isEmpty) {
                Task { await coordinator.sendEmailOTP(email: email) }
            }
        }
    }

    // MARK: - Code entry (step 2)

    private var codeEntrySection: some View {
        VStack(spacing: 12) {
            if let pendingEmail = coordinator.pendingEmailOTPEmail {
                Text("Code sent to **\(pendingEmail)**")
                    .font(.footnote)
                    .foregroundStyle(Color.amux.basalt)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            authField {
                TextField("6-digit code", text: $code)
                    .textContentType(.oneTimeCode)
                    .keyboardType(.numberPad)
                    .accessibilityIdentifier("login.codeField")
                    .onChange(of: code) { _, newValue in
                        let digits = newValue.filter { $0.isNumber }
                        code = String(digits.prefix(6))
                    }
            }

            primaryButton(title: "Verify", enabled: code.count == 6) {
                guard let pendingEmail = coordinator.pendingEmailOTPEmail else { return }
                Task { await coordinator.verifyOTP(email: pendingEmail, token: code) }
            }

            Button {
                code = ""
                coordinator.resetPendingEmailOTP()
            } label: {
                Text("Use a different email")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Color.amux.cinnabarDeep)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Shared widgets

    private func primaryButton(title: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if coordinator.isBusy {
                    ProgressView()
                        .progressViewStyle(.circular)
                        .tint(enabled ? Color.white : Color.amux.slate)
                }
                Text(title)
                    .font(.body.weight(.semibold))
            }
            .foregroundStyle(enabled ? Color.white : Color.amux.slate)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(enabled ? Color.amux.cinnabar : Color.amux.pebble.opacity(0.82))
                    .shadow(color: enabled ? Color.amux.onyx.opacity(0.10) : .clear,
                            radius: 18, x: 0, y: 10)
            )
        }
        .buttonStyle(.plain)
        .disabled(!enabled || coordinator.isBusy)
        .accessibilityIdentifier("login.submitButton")
    }

    private var divider: some View {
        HStack(spacing: 14) {
            Rectangle().fill(Color.amux.hairline).frame(height: 0.5)
            Text("or")
                .font(.footnote)
                .foregroundStyle(Color.amux.slate)
            Rectangle().fill(Color.amux.hairline).frame(height: 0.5)
        }
    }

    private var socialButtons: some View {
        VStack(spacing: 10) {
            socialButton(title: "Sign in with Apple", icon: "applelogo") {
                Task { await coordinator.signInWithApple() }
            }

            socialButton(title: "Sign in with Google", icon: "globe") {
                Task { await signInWithGoogleOAuth() }
            }
        }
    }

    private func authField<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .font(.body)
            .foregroundStyle(Color.amux.onyx)
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color.amux.paper)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(Color.amux.hairline, lineWidth: 1)
            )
    }

    // MARK: - Google OAuth via ASWebAuthenticationSession

    @MainActor
    private func signInWithGoogleOAuth() async {
        guard !coordinator.isBusy else { return }
        guard let authorizeURL = await coordinator.oauthAuthorizeURL() else {
            // Store does not support PKCE OAuth (e.g. Supabase fallback); no-op.
            return
        }

        // Mark busy while the browser session is open.
        coordinator.isBusy = true
        coordinator.errorMessage = nil

        let callbackURL: URL
        do {
            callbackURL = try await withCheckedThrowingContinuation { continuation in
                let session = ASWebAuthenticationSession(
                    url: authorizeURL,
                    callbackURLScheme: "teamclaw"
                ) { url, error in
                    if let error = error as? ASWebAuthenticationSessionError,
                       error.code == .canceledLogin {
                        // User cancelled — treat as silent no-op.
                        continuation.resume(throwing: CancellationError())
                        return
                    }
                    if let error {
                        continuation.resume(throwing: error)
                        return
                    }
                    if let url {
                        continuation.resume(returning: url)
                    } else {
                        continuation.resume(throwing: ASWebAuthenticationSessionError(
                            .presentationContextNotProvided))
                    }
                }
                session.presentationContextProvider = WebAuthContextProvider.shared
                session.prefersEphemeralWebBrowserSession = true
                session.start()
            }
        } catch is CancellationError {
            coordinator.isBusy = false
            return
        } catch {
            coordinator.isBusy = false
            coordinator.errorMessage = error.localizedDescription
            return
        }

        // Release our isBusy lock before delegating to handleAuthCallback,
        // which guards against re-entry itself and manages isBusy internally.
        coordinator.isBusy = false
        await coordinator.handleAuthCallback(url: callbackURL)
    }

    private func socialButton(title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 19, weight: .medium))
                    .frame(width: 24)
                Text(title)
                    .font(.body.weight(.semibold))
            }
            .foregroundStyle(Color.amux.onyx)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Color.amux.paper.opacity(0.82))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(Color.amux.hairline, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(coordinator.isBusy)
    }
}

// MARK: - ASWebAuthentication presentation context

/// Provides the key window as the presentation anchor for
/// `ASWebAuthenticationSession`. A single shared instance is sufficient
/// because the session is always presented from the app's active window.
private final class WebAuthContextProvider: NSObject,
    ASWebAuthenticationPresentationContextProviding, @unchecked Sendable {

    static let shared = WebAuthContextProvider()

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        // Walk the connected scenes to find the first key window.
        let windowScene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
            ?? UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first
        return windowScene?.keyWindow ?? ASPresentationAnchor()
    }
}
