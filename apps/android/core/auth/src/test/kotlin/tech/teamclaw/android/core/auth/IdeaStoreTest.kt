package tech.teamclaw.android.core.auth

import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Test
import tech.teamclaw.android.core.model.IdeaCreateInput
import tech.teamclaw.android.core.model.IdeaRecord
import tech.teamclaw.android.core.model.IdeaStatus
import tech.teamclaw.android.core.model.IdeaUpdateInput

private fun sampleIdea(
    id: String,
    title: String = "Title $id",
    description: String = "Description",
    status: String = IdeaStatus.OPEN,
    archived: Boolean = false,
    workspaceId: String = "",
    updatedAtMs: Long = 0L,
) = IdeaRecord(
    id = id,
    teamId = "T",
    workspaceId = workspaceId,
    createdByActorId = "actor",
    title = title,
    description = description,
    status = status,
    archived = archived,
    createdAtMs = 0L,
    updatedAtMs = updatedAtMs,
)

@OptIn(ExperimentalCoroutinesApi::class)
class IdeaStoreTest {

    private class FakeIdeaRepo(
        var rows: List<IdeaRecord> = emptyList(),
        var error: Throwable? = null,
    ) : IdeaRepository {
        var lastCreated: IdeaCreateInput? = null
        var lastUpdated: Pair<String, IdeaUpdateInput>? = null
        var lastArchived: Pair<String, Boolean>? = null

        override suspend fun listIdeas(teamId: String): List<IdeaRecord> {
            error?.let { throw it }
            return rows
        }

        override suspend fun createIdea(teamId: String, input: IdeaCreateInput): IdeaRecord {
            lastCreated = input
            error?.let { throw it }
            return sampleIdea(
                id = "new-${input.title}",
                title = input.title,
                description = input.description,
                workspaceId = input.workspaceId,
                updatedAtMs = 10_000L,
            )
        }

        override suspend fun updateIdea(ideaId: String, input: IdeaUpdateInput): IdeaRecord {
            lastUpdated = ideaId to input
            error?.let { throw it }
            return sampleIdea(
                id = ideaId,
                title = input.title,
                description = input.description,
                status = input.status,
                workspaceId = input.workspaceId,
                updatedAtMs = 20_000L,
            )
        }

        override suspend fun setArchived(ideaId: String, archived: Boolean): IdeaRecord {
            lastArchived = ideaId to archived
            error?.let { throw it }
            return sampleIdea(id = ideaId, archived = archived, updatedAtMs = 30_000L)
        }
    }

    @Test fun `reload partitions active and archived`() = runTest {
        val repo = FakeIdeaRepo(
            rows = listOf(
                sampleIdea(id = "1", title = "Open one", updatedAtMs = 1L),
                sampleIdea(id = "2", title = "Done one", archived = true, updatedAtMs = 2L),
                sampleIdea(id = "3", title = "Newer open", updatedAtMs = 3L),
            ),
        )
        val store = IdeaStore("T", repo)

        store.reload()

        // most-recently-updated active wins; archived is its own bucket
        val s = store.state.value
        assertThat(s.ideas.map { it.id }).containsExactly("3", "1").inOrder()
        assertThat(s.archivedIdeas.map { it.id }).containsExactly("2")
        assertThat(s.errorMessage).isNull()
    }

    @Test fun `create merges new idea into active bucket`() = runTest {
        val repo = FakeIdeaRepo(rows = listOf(sampleIdea(id = "1", updatedAtMs = 1L)))
        val store = IdeaStore("T", repo).also { it.reload() }

        val ok = store.create(title = "Fresh", description = "body", workspaceId = "ws")

        assertThat(ok).isTrue()
        assertThat(repo.lastCreated?.title).isEqualTo("Fresh")
        assertThat(repo.lastCreated?.workspaceId).isEqualTo("ws")
        assertThat(store.state.value.ideas.map { it.id }).containsExactly("new-Fresh", "1")
    }

    @Test fun `update overwrites existing idea`() = runTest {
        val repo = FakeIdeaRepo(rows = listOf(sampleIdea(id = "1", title = "Old", updatedAtMs = 1L)))
        val store = IdeaStore("T", repo).also { it.reload() }

        val ok = store.update(
            ideaId = "1",
            title = "New",
            description = "d",
            status = IdeaStatus.IN_PROGRESS,
            workspaceId = "ws",
        )

        assertThat(ok).isTrue()
        val refreshed = store.idea("1")
        assertThat(refreshed?.title).isEqualTo("New")
        assertThat(refreshed?.status).isEqualTo(IdeaStatus.IN_PROGRESS)
    }

    @Test fun `setArchived moves idea between buckets`() = runTest {
        val repo = FakeIdeaRepo(rows = listOf(sampleIdea(id = "1", updatedAtMs = 1L)))
        val store = IdeaStore("T", repo).also { it.reload() }

        store.setArchived(ideaId = "1", archived = true)

        val s = store.state.value
        assertThat(s.ideas).isEmpty()
        assertThat(s.archivedIdeas.map { it.id }).containsExactly("1")
        assertThat(repo.lastArchived).isEqualTo("1" to true)
    }

    @Test fun `reload surfaces error`() = runTest {
        val repo = FakeIdeaRepo(error = RuntimeException("rls denied"))
        val store = IdeaStore("T", repo)

        store.reload()

        assertThat(store.state.value.errorMessage).contains("rls denied")
    }
}
