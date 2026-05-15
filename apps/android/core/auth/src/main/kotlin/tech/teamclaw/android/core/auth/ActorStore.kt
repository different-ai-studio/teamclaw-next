package tech.teamclaw.android.core.auth

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import tech.teamclaw.android.core.model.ActorRecord
import tech.teamclaw.android.core.model.InviteCreateInput
import tech.teamclaw.android.core.model.InviteCreated

class ActorStore(
    private val teamId: String,
    private val repository: ActorRepository,
) {
    data class UiState(
        val actors: List<ActorRecord> = emptyList(),
        val isLoading: Boolean = false,
        val errorMessage: String? = null,
        val lastInvite: InviteCreated? = null,
        val isInviting: Boolean = false,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    suspend fun reload() {
        if (_state.value.isLoading) return
        _state.update { it.copy(isLoading = true, errorMessage = null) }
        try {
            val rows = repository.listActors(teamId)
            _state.update { it.copy(actors = rows, isLoading = false) }
        } catch (t: Throwable) {
            _state.update { it.copy(errorMessage = t.message, isLoading = false) }
        }
    }

    suspend fun createInvite(input: InviteCreateInput) {
        if (_state.value.isInviting) return
        _state.update { it.copy(isInviting = true, errorMessage = null) }
        try {
            val invite = repository.createInvite(teamId, input)
            _state.update { it.copy(lastInvite = invite, isInviting = false) }
        } catch (t: Throwable) {
            _state.update { it.copy(errorMessage = t.message, isInviting = false) }
        }
    }

    fun clearLastInvite() {
        _state.update { it.copy(lastInvite = null) }
    }
}
