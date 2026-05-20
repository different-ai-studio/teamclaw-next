package tech.teamclaw.android.core.model

/**
 * Kotlin port of iOS `IdeaRecord` (apps/ios/Packages/AMUXCore/Sources/AMUXCore/Ideas/IdeaRecord.swift).
 *
 * Schema mirrors the Supabase `ideas` table; status is one of "open" /
 * "in_progress" / "done" (`IdeaStatus` provides typed constants).
 */
data class IdeaRecord(
    val id: String,
    val teamId: String,
    val workspaceId: String,
    val createdByActorId: String,
    val title: String,
    val description: String,
    val status: String,
    val archived: Boolean,
    val createdAtMs: Long,
    val updatedAtMs: Long,
) {
    val displayTitle: String
        get() {
            if (title.isNotEmpty()) return title
            if (description.length <= MAX_PREVIEW) return description
            val prefix = description.take(MAX_PREVIEW)
            val lastSpace = prefix.lastIndexOf(' ')
            return if (lastSpace > 0) prefix.substring(0, lastSpace) + "…" else "$prefix…"
        }

    val isOpen: Boolean get() = status == IdeaStatus.OPEN
    val isInProgress: Boolean get() = status == IdeaStatus.IN_PROGRESS
    val isDone: Boolean get() = status == IdeaStatus.DONE

    val statusLabel: String
        get() = when (status) {
            IdeaStatus.OPEN -> "Open"
            IdeaStatus.IN_PROGRESS -> "In Progress"
            IdeaStatus.DONE -> "Done"
            else -> status
        }

    companion object {
        private const val MAX_PREVIEW = 50
    }
}

object IdeaStatus {
    const val OPEN = "open"
    const val IN_PROGRESS = "in_progress"
    const val DONE = "done"

    val all: List<String> = listOf(OPEN, IN_PROGRESS, DONE)
}

data class IdeaCreateInput(
    val title: String,
    val description: String,
    val workspaceId: String,
)

data class IdeaUpdateInput(
    val title: String,
    val description: String,
    val status: String,
    val workspaceId: String,
)
