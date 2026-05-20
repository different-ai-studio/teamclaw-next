package tech.teamclaw.android.core.auth

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import tech.teamclaw.android.core.model.IdeaCreateInput
import tech.teamclaw.android.core.model.IdeaRecord
import tech.teamclaw.android.core.model.IdeaUpdateInput

/**
 * Per-team Ideas cache. Port of iOS `IdeaStore`
 * (apps/ios/Packages/AMUXCore/Sources/AMUXCore/Ideas/IdeaStore.swift).
 *
 * Splits active vs archived buckets so the UI doesn't have to filter on
 * every render. Sort: most-recently-updated first (ties broken by
 * created_at desc), mirroring the iOS behavior.
 */
class IdeaStore(
    private val teamId: String,
    private val repository: IdeaRepository,
) {
    data class UiState(
        val ideas: List<IdeaRecord> = emptyList(),
        val archivedIdeas: List<IdeaRecord> = emptyList(),
        val isLoading: Boolean = false,
        val errorMessage: String? = null,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    fun idea(id: String): IdeaRecord? =
        (_state.value.ideas + _state.value.archivedIdeas).firstOrNull { it.id == id }

    suspend fun reload() {
        if (_state.value.isLoading) return
        _state.update { it.copy(isLoading = true, errorMessage = null) }
        try {
            val rows = repository.listIdeas(teamId)
            apply(rows)
        } catch (t: Throwable) {
            _state.update { it.copy(isLoading = false, errorMessage = t.message) }
        }
    }

    suspend fun create(title: String, description: String, workspaceId: String): Boolean {
        return try {
            val created = repository.createIdea(
                teamId = teamId,
                input = IdeaCreateInput(
                    title = title.trim(),
                    description = description.trim(),
                    workspaceId = workspaceId,
                ),
            )
            merge(created)
            _state.update { it.copy(errorMessage = null) }
            true
        } catch (t: Throwable) {
            _state.update { it.copy(errorMessage = t.message) }
            false
        }
    }

    suspend fun update(
        ideaId: String,
        title: String,
        description: String,
        status: String,
        workspaceId: String,
    ): Boolean {
        return try {
            val updated = repository.updateIdea(
                ideaId = ideaId,
                input = IdeaUpdateInput(
                    title = title.trim(),
                    description = description.trim(),
                    status = status,
                    workspaceId = workspaceId,
                ),
            )
            merge(updated)
            _state.update { it.copy(errorMessage = null) }
            true
        } catch (t: Throwable) {
            _state.update { it.copy(errorMessage = t.message) }
            false
        }
    }

    suspend fun setArchived(ideaId: String, archived: Boolean): Boolean {
        return try {
            val updated = repository.setArchived(ideaId = ideaId, archived = archived)
            merge(updated)
            _state.update { it.copy(errorMessage = null) }
            true
        } catch (t: Throwable) {
            _state.update { it.copy(errorMessage = t.message) }
            false
        }
    }

    private fun apply(records: List<IdeaRecord>) {
        val sorted = sort(records)
        val (archived, active) = sorted.partition { it.archived }
        _state.update {
            it.copy(
                ideas = active,
                archivedIdeas = archived,
                isLoading = false,
            )
        }
    }

    private fun merge(record: IdeaRecord) {
        val all = (_state.value.ideas + _state.value.archivedIdeas)
            .associateBy { it.id }
            .toMutableMap()
        all[record.id] = record
        apply(all.values.toList())
    }

    private fun sort(records: List<IdeaRecord>): List<IdeaRecord> =
        records.sortedWith(
            compareByDescending<IdeaRecord> { it.updatedAtMs }
                .thenByDescending { it.createdAtMs },
        )
}
