package tech.teamclaw.android.core.model

import kotlinx.serialization.Serializable

@Serializable
data class ActorRecord(
    val id: String,
    val teamId: String,
    /** "member" or "agent". */
    val actorType: String,
    val userId: String?,
    val invitedByActorId: String?,
    val displayName: String,
    /** Unix-epoch millis. Null when never seen. */
    val lastActiveAtMs: Long?,
    val createdAtMs: Long,
    val updatedAtMs: Long,
    val memberStatus: String?,
    /** "owner", "admin", "member", or null for agents. */
    val teamRole: String?,
    val agentKind: String?,
    val agentStatus: String?,
) {
    val isMember: Boolean get() = actorType == "member"
    val isAgent: Boolean get() = actorType == "agent"
    val isOwner: Boolean get() = teamRole == "owner"
    val isOnline: Boolean
        get() = lastActiveAtMs?.let { (System.currentTimeMillis() - it) < 90_000 } ?: false

    val roleLabel: String
        get() = when (teamRole) {
            "owner" -> "Owner"
            "admin" -> "Admin"
            "member" -> "Member"
            else -> "—"
        }
}

enum class InviteKind { MEMBER, AGENT;

    val wire: String get() = name.lowercase()
}

enum class TeamRole { MEMBER, ADMIN;

    val wire: String get() = name.lowercase()
}

@Serializable
data class InviteCreateInput(
    val kind: InviteKind,
    val displayName: String,
    val teamRole: TeamRole? = null,
    val agentKind: String? = null,
    val ttlSeconds: Int = 604_800,
    val targetActorId: String? = null,
)

data class InviteCreated(
    val token: String,
    val expiresAtMs: Long,
    val deeplink: String,
)
