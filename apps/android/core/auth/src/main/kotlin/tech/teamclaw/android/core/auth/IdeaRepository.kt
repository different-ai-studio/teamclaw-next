package tech.teamclaw.android.core.auth

import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.postgrest.query.Columns
import io.github.jan.supabase.postgrest.query.Order
import kotlinx.datetime.Instant
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import tech.teamclaw.android.core.model.IdeaCreateInput
import tech.teamclaw.android.core.model.IdeaRecord
import tech.teamclaw.android.core.model.IdeaUpdateInput

/**
 * Port of iOS `IdeaRepository` + `SupabaseIdeaRepository`
 * (apps/ios/Packages/AMUXCore/Sources/AMUXCore/Ideas/).
 *
 * Same Supabase contract: list rows from `ideas`, mutate via the
 * `create_idea` / `update_idea` / `archive_idea` RPCs.
 */
interface IdeaRepository {
    suspend fun listIdeas(teamId: String): List<IdeaRecord>
    suspend fun createIdea(teamId: String, input: IdeaCreateInput): IdeaRecord
    suspend fun updateIdea(ideaId: String, input: IdeaUpdateInput): IdeaRecord
    suspend fun setArchived(ideaId: String, archived: Boolean): IdeaRecord
}

class SupabaseIdeaRepository(
    private val client: SupabaseClient,
) : IdeaRepository {

    override suspend fun listIdeas(teamId: String): List<IdeaRecord> {
        val rows: List<IdeaRow> = client.postgrest.from("ideas")
            .select(
                columns = Columns.list(
                    "id", "team_id", "workspace_id", "created_by_actor_id",
                    "title", "description", "status", "archived",
                    "created_at", "updated_at",
                ),
            ) {
                filter { eq("team_id", teamId) }
                order(column = "updated_at", order = Order.DESCENDING)
            }
            .decodeList()
        return rows.map { it.toRecord() }
    }

    override suspend fun createIdea(teamId: String, input: IdeaCreateInput): IdeaRecord {
        val title = input.title.trim()
        require(title.isNotEmpty()) { "Title is required." }
        val workspaceId = input.workspaceId.trim().ifEmpty { null }

        val params = buildJsonObject {
            put("p_team_id", teamId)
            workspaceId?.let { put("p_workspace_id", it) }
            put("p_title", title)
            put("p_description", input.description)
        }
        val rows: List<IdeaRow> = client.postgrest.rpc("create_idea", params).decodeList()
        val row = rows.firstOrNull()
            ?: throw IllegalStateException("create_idea returned no rows")
        return row.toRecord()
    }

    override suspend fun updateIdea(ideaId: String, input: IdeaUpdateInput): IdeaRecord {
        val title = input.title.trim()
        require(title.isNotEmpty()) { "Title is required." }
        val workspaceId = input.workspaceId.trim().ifEmpty { null }

        val params = buildJsonObject {
            put("p_idea_id", ideaId)
            workspaceId?.let { put("p_workspace_id", it) }
            put("p_title", title)
            put("p_description", input.description)
            put("p_status", input.status)
        }
        val rows: List<IdeaRow> = client.postgrest.rpc("update_idea", params).decodeList()
        val row = rows.firstOrNull()
            ?: throw IllegalStateException("update_idea returned no rows")
        return row.toRecord()
    }

    override suspend fun setArchived(ideaId: String, archived: Boolean): IdeaRecord {
        val params = buildJsonObject {
            put("p_idea_id", ideaId)
            put("p_archived", archived)
        }
        val rows: List<IdeaRow> = client.postgrest.rpc("archive_idea", params).decodeList()
        val row = rows.firstOrNull()
            ?: throw IllegalStateException("archive_idea returned no rows")
        return row.toRecord()
    }

    @Serializable
    private data class IdeaRow(
        val id: String,
        @SerialName("team_id") val teamId: String,
        @SerialName("workspace_id") val workspaceId: String?,
        @SerialName("created_by_actor_id") val createdByActorId: String,
        val title: String,
        val description: String,
        val status: String,
        val archived: Boolean,
        @SerialName("created_at") val createdAt: Instant,
        @SerialName("updated_at") val updatedAt: Instant,
    ) {
        fun toRecord(): IdeaRecord = IdeaRecord(
            id = id,
            teamId = teamId,
            workspaceId = workspaceId.orEmpty(),
            createdByActorId = createdByActorId,
            title = title,
            description = description,
            status = status,
            archived = archived,
            createdAtMs = createdAt.toEpochMilliseconds(),
            updatedAtMs = updatedAt.toEpochMilliseconds(),
        )
    }
}
