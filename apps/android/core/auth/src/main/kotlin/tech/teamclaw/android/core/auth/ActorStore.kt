package tech.teamclaw.android.core.auth

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import tech.teamclaw.android.core.model.ActorRecord
import tech.teamclaw.android.core.model.InviteCreateInput
import tech.teamclaw.android.core.model.InviteCreated
import tech.teamclaw.android.core.model.InviteKind
import tech.teamclaw.android.core.model.TeamRole

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

    /** Generate a new invite token that rotates credentials on [actorId]
     *  instead of creating a new actor row. Caller forwards the resulting
     *  deeplink to the actor owner (e.g. the agent needs to re-register
     *  with the new token; the human re-clicks the link).
     */
    suspend fun rotateActor(actorId: String, displayName: String, kind: InviteKind, agentKind: String?) {
        createInvite(
            InviteCreateInput(
                kind = kind,
                displayName = displayName,
                teamRole = if (kind == InviteKind.MEMBER) TeamRole.MEMBER else null,
                agentKind = agentKind,
                targetActorId = actorId,
            )
        )
    }

    suspend fun removeActor(actorId: String) {
        try {
            repository.removeActor(actorId)
            _state.update { it.copy(actors = it.actors.filterNot { a -> a.id == actorId }) }
        } catch (t: Throwable) {
            _state.update { it.copy(errorMessage = t.message) }
        }
    }

    fun clearLastInvite() {
        _state.update { it.copy(lastInvite = null) }
    }
}
