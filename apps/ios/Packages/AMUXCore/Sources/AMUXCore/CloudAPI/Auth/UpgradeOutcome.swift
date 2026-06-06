import Foundation

/// Typed result of an anonymous-account upgrade that collided with an
/// identifier already owned by another account. Surfaced so the UI can offer a
/// "sign in to that account instead" path rather than dumping GoTrue's raw
/// English error string.
public enum UpgradeOutcome: Error, Equatable, Sendable {
    case emailAlreadyInUse
    case phoneAlreadyInUse
}

/// Classifies auth errors that aren't expressible as a clean status code on
/// their own. Detection is deliberately version-resilient: GoTrue's machine
/// `error_code` is preferred (forwarded by FC under `details.error_code`, which
/// `AuthHTTP` surfaces as `CloudAPIError.requestFailed.code`), with a human
/// message fallback for GoTrue builds that omit it.
public enum AuthErrorClassifier {
    /// True when `error` is GoTrue rejecting an email/phone because it already
    /// belongs to another account (HTTP 422, `email_exists` / `phone_exists`).
    public static func isIdentifierAlreadyInUse(_ error: Error) -> Bool {
        guard let api = error as? CloudAPIError,
              case let .requestFailed(status, code, message) = api,
              status == 422 else { return false }
        if let code, ["email_exists", "phone_exists"].contains(code) { return true }
        return messageIndicatesAlreadyInUse(message)
    }

    /// True when an invite claim failed because the authenticated user is
    /// already a member of the target team (RPC errcode 23505). Benign for the
    /// sign-in-then-join path — the user already has access.
    public static func isAlreadyTeamMember(_ error: Error) -> Bool {
        messageContains(error, "already a member")
    }

    /// True when an invite claim failed because the token was already consumed
    /// (RPC errcode 23514) — a single-use member invite spent by an earlier
    /// claim. The user needs a fresh link.
    public static func isInviteConsumed(_ error: Error) -> Bool {
        messageContains(error, "already consumed")
    }

    // MARK: - Helpers

    static func messageIndicatesAlreadyInUse(_ message: String) -> Bool {
        let m = message.lowercased()
        if m.contains("already") && (m.contains("regist") || m.contains("in use") || m.contains("exists")) {
            return true
        }
        return m.contains("已注册") || m.contains("已被使用")
    }

    private static func messageContains(_ error: Error, _ needle: String) -> Bool {
        if let api = error as? CloudAPIError,
           case let .requestFailed(_, _, message) = api {
            return message.lowercased().contains(needle)
        }
        return error.localizedDescription.lowercased().contains(needle)
    }
}
