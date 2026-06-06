import Foundation

/// `AppOnboardingStore` implemented entirely over the TeamClaw Cloud API (FC),
/// replacing the Supabase-SDK-backed `SupabaseAppOnboardingStore`.
///
/// Token lifecycle (Keychain persistence, proactive/reactive refresh, the
/// `tokenRefreshes()` stream MQTT depends on) is delegated to `SessionStore`.
/// The unauthenticated GoTrue-proxy auth endpoints are hit via `AuthHTTP`; the
/// authenticated business endpoints (`/v1/me/bootstrap`, `/v1/teams`,
/// `/v1/invites/claim`) go through `CloudAPIClient`, whose bearer is supplied
/// by `SessionStore.accessToken()`.
public actor CloudAPIAppOnboardingStore: AppOnboardingStore {
    private let sessionStore: SessionStore
    private let auth: AuthHTTP
    private let api: CloudAPIClient
    private let pkce: PKCEStore

    private var didStart = false

    public init(
        configuration: CloudAPIConfiguration,
        storage: SessionStorage,
        send: @escaping CloudAPISend = CloudAPIClient.urlSessionSend
    ) {
        let sessionStore = SessionStore(baseURL: configuration.baseURL, storage: storage, send: send)
        self.sessionStore = sessionStore
        self.auth = AuthHTTP(baseURL: configuration.baseURL, send: send)
        self.api = CloudAPIClient(
            configuration: configuration,
            accessToken: { try await sessionStore.accessToken() },
            send: send
        )
        self.pkce = PKCEStore()
    }

    /// Bridge-only handle to the underlying `SessionStore`. Used exclusively by
    /// `SupabaseSessionBridge` at app composition to seed the Cloud API session
    /// from an existing legacy Supabase session before first use. Not part of
    /// the `AppOnboardingStore` protocol; do not use for normal token access
    /// (go through `accessToken()` instead).
    public nonisolated var sessionStoreForBridge: SessionStore { sessionStore }

    /// Hydrate the session from storage exactly once, before any operation.
    /// Done lazily (rather than a fire-and-forget `Task` in `init`) so the
    /// first call deterministically observes any persisted session.
    private func ensureStarted() async {
        guard !didStart else { return }
        didStart = true
        await sessionStore.start()
    }

    // MARK: - Session presence

    public func ensureSession() async throws {
        await ensureStarted()
        // Both authenticated and anonymous sessions are valid; only the
        // absence of a session counts as "needs auth".
        guard await sessionStore.currentSession() != nil else {
            throw AuthRequired.notAuthenticated
        }
    }

    public func isAnonymous() async -> Bool {
        await ensureStarted()
        return await sessionStore.currentSession()?.isAnonymous ?? false
    }

    public func currentUserEmail() async -> String? {
        await ensureStarted()
        return await sessionStore.currentSession()?.email
    }

    public func accessToken() async throws -> String {
        await ensureStarted()
        return try await sessionStore.accessToken()
    }

    public nonisolated func tokenRefreshes() -> AsyncStream<Void> {
        sessionStore.tokenRefreshes()
    }

    // MARK: - Sign-in / sign-up

    public func signIn(email: String, password: String) async throws {
        await ensureStarted()
        let g: GoTrueSession = try await auth.post(
            "/v1/auth/signin-password",
            body: PasswordCredentials(email: email, password: password)
        )
        try await store(g)
    }

    public func signUp(email: String, password: String) async throws {
        await ensureStarted()
        let g: GoTrueSession = try await auth.post(
            "/v1/auth/signup",
            body: PasswordCredentials(email: email, password: password)
        )
        // FC forwards the raw GoTrue 200 body. Two cases lack a session and
        // must surface as explicit outcomes (otherwise the coordinator falls
        // through to bootstrap → .needsAuth with no error):
        //   • emailAlreadyInUse: anti-enumeration; user has empty identities.
        //   • emailConfirmationRequired: real new user pending confirmation.
        guard g.accessToken == nil else {
            try await store(g)
            return
        }
        let identities = g.user?.identities ?? []
        throw identities.isEmpty
            ? SignUpOutcome.emailAlreadyInUse
            : SignUpOutcome.emailConfirmationRequired
    }

    public func sendEmailOTP(email: String) async throws {
        await ensureStarted()
        // Mirror the Supabase store: create the user if needed. GoTrue decides
        // link-vs-code from the Auth email template ({{ .Token }} → 6-digit).
        try await auth.postVoid(
            "/v1/auth/signin-otp",
            body: OTPRequest(email: email, options: .init(shouldCreateUser: true))
        )
    }

    public func verifyOTP(email: String, token: String) async throws {
        await ensureStarted()
        // The Supabase store tried `.email` then fell back to `.signup`.
        // Replicate by retrying with type "signup" on first failure.
        do {
            let g: GoTrueSession = try await auth.post(
                "/v1/auth/verify-otp",
                body: VerifyOTPRequest(email: email, token: token, type: "email")
            )
            try await store(g)
        } catch {
            let g: GoTrueSession = try await auth.post(
                "/v1/auth/verify-otp",
                body: VerifyOTPRequest(email: email, token: token, type: "signup")
            )
            try await store(g)
        }
    }

    public func sendPhoneOTP(phone: String) async throws {
        await ensureStarted()
        // GoTrue sends an SMS code for the E.164 phone; FC defaults channel sms.
        try await auth.postVoid(
            "/v1/auth/signin-otp",
            body: PhoneOTPRequest(phone: phone, options: .init(shouldCreateUser: true))
        )
    }

    public func verifyPhoneOTP(phone: String, token: String) async throws {
        await ensureStarted()
        let g: GoTrueSession = try await auth.post(
            "/v1/auth/verify-otp",
            body: VerifyPhoneOTPRequest(phone: phone, token: token, type: "sms")
        )
        try await store(g)
    }

    public func signInWithAppleCredential(idToken: String, nonce: String) async throws {
        await ensureStarted()
        let g: GoTrueSession = try await auth.post(
            "/v1/auth/signin-idtoken",
            body: IdTokenRequest(provider: "apple", idToken: idToken, nonce: nonce)
        )
        try await store(g)
    }

    public func signInAnonymously() async throws {
        await ensureStarted()
        let g: GoTrueSession = try await auth.post("/v1/auth/signin-anonymous", body: EmptyBody())
        try await store(g)
    }

    /// Establish a session from a `refresh_token` (e.g. one returned by an
    /// agent / member-reinvite claim). Hits the camelCase `/v1/auth/refresh`.
    public func setSession(refreshToken: String) async throws {
        await ensureStarted()
        let res: RefreshResponse = try await auth.post(
            "/v1/auth/refresh",
            body: RefreshRequest(refreshToken: refreshToken)
        )
        await sessionStore.setSession(
            StoredSession(
                accessToken: res.accessToken,
                refreshToken: res.refreshToken,
                expiresAt: Date(timeIntervalSince1970: TimeInterval(res.expiresAt)),
                isAnonymous: false,
                email: nil
            )
        )
    }

    public func signOut() async throws {
        await ensureStarted()
        // Best-effort GoTrue logout with the current bearer, then clear local
        // state regardless of the network outcome.
        if let token = try? await sessionStore.accessToken() {
            try? await auth.postVoid("/v1/auth/signout", body: EmptyBody(), bearer: token)
        }
        await sessionStore.clear()
    }

    // MARK: - Anonymous → permanent account upgrade

    /// Re-raise an "identifier already belongs to another account" GoTrue
    /// rejection as a typed `UpgradeOutcome` so the coordinator/UI can offer a
    /// "sign in to that account instead" path. Other errors pass through.
    private func mapUpgradeCollision<T>(phone: Bool, _ work: () async throws -> T) async throws -> T {
        do {
            return try await work()
        } catch {
            if AuthErrorClassifier.isIdentifierAlreadyInUse(error) {
                throw phone ? UpgradeOutcome.phoneAlreadyInUse : UpgradeOutcome.emailAlreadyInUse
            }
            throw error
        }
    }

    public func upgradeWithPassword(email: String, password: String) async throws {
        await ensureStarted()
        let token = try await sessionStore.accessToken()
        let g: GoTrueSession = try await mapUpgradeCollision(phone: false) {
            try await auth.patch(
                "/v1/auth/user",
                body: PasswordCredentials(email: email, password: password),
                bearer: token
            )
        }
        // PATCH /auth/v1/user returns the updated user, not necessarily a new
        // session. Only adopt it when it actually carries fresh tokens;
        // otherwise the existing session (same user_id) remains valid.
        if g.accessToken != nil {
            try await store(g)
        }
    }

    public func sendUpgradeEmailOTP(email: String) async throws {
        await ensureStarted()
        // GoTrue email_change: PATCH the user's email with the current bearer.
        // This emails a verification code (the {{ .Token }} → 6-digit template)
        // without minting a new user, so the upgrade keeps the same user_id.
        let token = try await sessionStore.accessToken()
        // PATCH returns the (still-anonymous) user; we don't adopt it here —
        // the session only changes after the code is verified.
        let _: GoTrueSession = try await mapUpgradeCollision(phone: false) {
            try await auth.patch(
                "/v1/auth/user",
                body: EmailUpdate(email: email),
                bearer: token
            )
        }
    }

    public func verifyUpgradeEmailOTP(email: String, token: String) async throws {
        await ensureStarted()
        let bearer = try await sessionStore.accessToken()
        let g: GoTrueSession = try await auth.post(
            "/v1/auth/verify-otp",
            body: VerifyOTPRequest(email: email, token: token, type: "email_change"),
            bearer: bearer
        )
        // verify-otp for email_change returns the updated session; adopt it
        // when present so the (now non-anonymous) tokens replace the old ones.
        if g.accessToken != nil {
            try await store(g)
        }
    }

    public func sendUpgradePhoneOTP(phone: String) async throws {
        await ensureStarted()
        // GoTrue phone_change: PATCH the user's phone with the current bearer.
        // This texts a verification code without minting a new user, so the
        // upgrade keeps the same user_id (mirror of `sendUpgradeEmailOTP`).
        let token = try await sessionStore.accessToken()
        // PATCH returns the (still-anonymous) user; we don't adopt it here —
        // the session only changes after the code is verified.
        let _: GoTrueSession = try await mapUpgradeCollision(phone: true) {
            try await auth.patch(
                "/v1/auth/user",
                body: PhoneUpdate(phone: phone),
                bearer: token
            )
        }
    }

    public func verifyUpgradePhoneOTP(phone: String, token: String) async throws {
        await ensureStarted()
        let bearer = try await sessionStore.accessToken()
        let g: GoTrueSession = try await auth.post(
            "/v1/auth/verify-otp",
            body: VerifyPhoneOTPRequest(phone: phone, token: token, type: "phone_change"),
            bearer: bearer
        )
        // verify-otp for phone_change returns the updated session; adopt it
        // when present so the (now non-anonymous) tokens replace the old ones.
        if g.accessToken != nil {
            try await store(g)
        }
    }

    public func upgradeWithAppleCredential(idToken: String, nonce: String) async throws {
        await ensureStarted()
        // Forwarding the bearer makes GoTrue link the Apple identity to the
        // current (anonymous) user instead of minting a new one.
        let token = try await sessionStore.accessToken()
        let g: GoTrueSession = try await auth.post(
            "/v1/auth/signin-idtoken",
            body: IdTokenRequest(provider: "apple", idToken: idToken, nonce: nonce),
            bearer: token
        )
        try await store(g)
    }

    // MARK: - Google OAuth (PKCE)

    /// The web/SFAuthenticationSession flow (Task 9) drives the browser. The
    /// protocol requires `signInWithGoogle()`, but with the Cloud API the URL
    /// must be opened by the UI layer; there is nothing for the store to do
    /// synchronously. The real work happens in `oauthAuthorizeURL` (which the
    /// UI opens) and `handleAuthCallback` (invoked on the redirect).
    public func signInWithGoogle() async throws {
        await ensureStarted()
    }

    /// Build the authorize URL for the Google OAuth flow, stashing a fresh
    /// PKCE verifier for the subsequent `handleAuthCallback` exchange.
    public func oauthAuthorizeURL(redirect: String = "teamclaw://auth-callback") async -> URL? {
        let challenge = await pkce.makeChallenge()
        let base = api.baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        var components = URLComponents(string: "\(base)/v1/auth/oauth/google/authorize")
        components?.queryItems = [
            URLQueryItem(name: "redirect", value: redirect),
            URLQueryItem(name: "code_challenge", value: challenge),
        ]
        return components?.url
    }

    public func handleAuthCallback(url: URL) async throws {
        await ensureStarted()
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let code = components.queryItems?.first(where: { $0.name == "code" })?.value,
              !code.isEmpty else {
            throw AuthRequired.notAuthenticated
        }
        guard let verifier = await pkce.takeVerifier() else {
            throw AuthRequired.notAuthenticated
        }
        let g: GoTrueSession = try await auth.post(
            "/v1/auth/oauth/exchange",
            body: PKCEExchangeRequest(code: code, codeVerifier: verifier)
        )
        try await store(g)
    }

    // MARK: - Business data

    public func loadBootstrap() async throws -> AppBootstrap {
        await ensureStarted()
        let dto: CloudBootstrap = try await api.get("/v1/me/bootstrap")
        return AppBootstrap(
            memberActorID: dto.memberActorId,
            teams: dto.teams.map {
                TeamSummary(id: $0.id, name: $0.name, slug: $0.slug ?? "", role: $0.role ?? "member")
            },
            memberActorIDByTeam: dto.memberActorIdByTeam ?? [:]
        )
    }

    public func createTeam(named name: String) async throws -> CreatedTeam {
        await ensureStarted()
        // POST /v1/teams returns only the team row (id/name/slug). The member
        // actor id + role are resolved via a follow-up bootstrap — the FC
        // create-team endpoint does not echo them back (unlike the Supabase
        // `create_team` RPC). Workspace id/name are not surfaced by the Cloud
        // API and are not consumed downstream (only `memberActorID` feeds the
        // active AppContext), so they default to empty.
        let team: CloudTeam = try await api.post("/v1/teams", body: CreateTeamRequest(name: name))
        let bootstrap = try await loadBootstrap()
        let role = bootstrap.teams.first(where: { $0.id == team.id })?.role ?? "owner"
        let memberActorID = bootstrap.memberActorIDByTeam[team.id]
            ?? bootstrap.memberActorID
            ?? ""
        return CreatedTeam(
            team: TeamSummary(id: team.id, name: team.name, slug: team.slug ?? "", role: role),
            memberActorID: memberActorID,
            workspaceID: "",
            workspaceName: ""
        )
    }

    public func claimInvite(token: String) async throws -> ClaimResult {
        await ensureStarted()
        let row: CloudClaimInviteResult = try await api.post(
            "/v1/invites/claim",
            body: ClaimInviteRequest(token: token)
        )
        return ClaimResult(
            actorID: row.actorId,
            teamID: row.teamId,
            actorType: row.actorType,
            displayName: row.displayName,
            refreshToken: row.refreshToken
        )
    }

    // MARK: - Private

    /// Commit a GoTrue session body into the SessionStore. Requires both
    /// tokens; otherwise the body did not represent an authenticated session.
    private func store(_ g: GoTrueSession) async throws {
        guard let accessToken = g.accessToken, let refreshToken = g.refreshToken else {
            throw AuthRequired.notAuthenticated
        }
        let expiresAt: Date
        if let epoch = g.expiresAt {
            expiresAt = Date(timeIntervalSince1970: TimeInterval(epoch))
        } else if let expiresIn = g.expiresIn {
            expiresAt = Date().addingTimeInterval(TimeInterval(expiresIn))
        } else {
            // Default to a conservative 1h horizon; SessionStore will refresh
            // proactively before this.
            expiresAt = Date().addingTimeInterval(3600)
        }
        await sessionStore.setSession(
            StoredSession(
                accessToken: accessToken,
                refreshToken: refreshToken,
                expiresAt: expiresAt,
                isAnonymous: g.user?.isAnonymous ?? false,
                email: g.user?.email
            )
        )
    }
}

// MARK: - GoTrue DTOs (raw snake_case body returned by the FC auth proxy)

private struct GoTrueSession: Decodable, Sendable {
    let accessToken: String?
    let refreshToken: String?
    let expiresAt: Int?
    let expiresIn: Int?
    let user: GoTrueUser?

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case expiresAt = "expires_at"
        case expiresIn = "expires_in"
        case user
    }
}

private struct GoTrueUser: Decodable, Sendable {
    let email: String?
    let isAnonymous: Bool?
    let identities: [GoTrueIdentity]?

    enum CodingKeys: String, CodingKey {
        case email
        case isAnonymous = "is_anonymous"
        case identities
    }
}

private struct GoTrueIdentity: Decodable, Sendable {}

// MARK: - Request bodies

private struct PasswordCredentials: Encodable, Sendable {
    let email: String
    let password: String
}

private struct EmailUpdate: Encodable, Sendable {
    let email: String
}

private struct PhoneUpdate: Encodable, Sendable {
    let phone: String
}

private struct OTPRequest: Encodable, Sendable {
    let email: String
    let options: Options
    struct Options: Encodable, Sendable {
        let shouldCreateUser: Bool
    }
}

private struct VerifyOTPRequest: Encodable, Sendable {
    let email: String
    let token: String
    let type: String
}

private struct PhoneOTPRequest: Encodable, Sendable {
    let phone: String
    let options: Options
    struct Options: Encodable, Sendable {
        let shouldCreateUser: Bool
    }
}

private struct VerifyPhoneOTPRequest: Encodable, Sendable {
    let phone: String
    let token: String
    let type: String
}

private struct IdTokenRequest: Encodable, Sendable {
    let provider: String
    let idToken: String
    let nonce: String
}

private struct RefreshRequest: Encodable, Sendable {
    let refreshToken: String
}

private struct RefreshResponse: Decodable, Sendable {
    let accessToken: String
    let refreshToken: String
    let expiresAt: Int
}

private struct PKCEExchangeRequest: Encodable, Sendable {
    let code: String
    let codeVerifier: String
}

private struct CreateTeamRequest: Encodable, Sendable {
    let name: String
}

private struct ClaimInviteRequest: Encodable, Sendable {
    let token: String
}

// MARK: - Business response DTOs

private struct CloudBootstrap: Decodable, Sendable {
    let memberActorId: String?
    let teams: [CloudBootstrapTeam]
    let memberActorIdByTeam: [String: String]?
}

private struct CloudBootstrapTeam: Decodable, Sendable {
    let id: String
    let name: String
    let slug: String?
    let role: String?
}

private struct CloudTeam: Decodable, Sendable {
    let id: String
    let name: String
    let slug: String?
}

private struct CloudClaimInviteResult: Decodable, Sendable {
    let actorId: String
    let teamId: String
    let actorType: String
    let displayName: String
    let refreshToken: String?
}
