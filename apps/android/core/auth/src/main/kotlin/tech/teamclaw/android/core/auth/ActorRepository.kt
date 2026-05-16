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
import tech.teamclaw.android.core.model.ActorRecord
import tech.teamclaw.android.core.model.InviteCreateInput
import tech.teamclaw.android.core.model.InviteCreated

interface ActorRepository {
    suspend fun listActors(teamId: String): List<ActorRecord>
    suspend fun createInvite(teamId: String, input: InviteCreateInput): InviteCreated
    suspend fun removeActor(actorId: String)
}

class SupabaseActorRepository(
    private val client: SupabaseClient,
) : ActorRepository {

    override suspend fun listActors(teamId: String): List<ActorRecord> {
        val rows: List<ActorRow> = client.postgrest.from("actor_directory")
            .select(
                columns = Columns.list(
                    "id", "team_id", "actor_type", "user_id", "invited_by_actor_id",
                    "display_name", "last_active_at", "created_at", "updated_at",
                    "member_status", "team_role", "agent_kind", "agent_status",
                ),
            ) {
                filter { eq("team_id", teamId) }
                order("display_name", order = Order.ASCENDING)
            }
            .decodeList()
        return rows.map { it.toRecord() }
    }

    override suspend fun createInvite(teamId: String, input: InviteCreateInput): InviteCreated {
        val params = buildJsonObject {
            put("p_team_id", teamId)
            put("p_kind", input.kind.wire)
            put("p_display_name", input.displayName.trim())
            input.teamRole?.let { put("p_team_role", it.wire) }
            input.agentKind?.let { put("p_agent_kind", it) }
            put("p_ttl_seconds", input.ttlSeconds)
            input.targetActorId?.let { put("p_target_actor_id", it) }
        }
        val rows: List<InviteRow> = client.postgrest
            .rpc("create_team_invite", params)
            .decodeList()
        val row = rows.firstOrNull()
            ?: throw IllegalStateException("create_team_invite returned no rows")
        return InviteCreated(
            token = row.token,
            expiresAtMs = row.expiresAt.toEpochMilliseconds(),
            deeplink = teamclawDeeplink(row.deeplink),
        )
    }

    override suspend fun removeActor(actorId: String) {
        client.postgrest.rpc(
            "remove_team_actor",
            buildJsonObject { put("p_actor_id", actorId) },
        )
    }

    private fun teamclawDeeplink(raw: String): String =
        if (raw.startsWith("amux://")) raw.replaceFirst("amux://", "teamclaw://") else raw

    private fun ActorRow.toRecord(): ActorRecord = ActorRecord(
        id = id,
        teamId = teamId,
        actorType = actorType,
        userId = userId,
        invitedByActorId = invitedByActorId,
        displayName = displayName,
        lastActiveAtMs = lastActiveAt?.toEpochMilliseconds(),
        createdAtMs = createdAt.toEpochMilliseconds(),
        updatedAtMs = updatedAt.toEpochMilliseconds(),
        memberStatus = memberStatus,
        teamRole = teamRole,
        agentKind = agentKind,
        agentStatus = agentStatus,
    )

    @Serializable
    private data class ActorRow(
        val id: String,
        @SerialName("team_id") val teamId: String,
        @SerialName("actor_type") val actorType: String,
        @SerialName("user_id") val userId: String?,
        @SerialName("invited_by_actor_id") val invitedByActorId: String?,
        @SerialName("display_name") val displayName: String,
        @SerialName("last_active_at") val lastActiveAt: Instant?,
        @SerialName("created_at") val createdAt: Instant,
        @SerialName("updated_at") val updatedAt: Instant,
        @SerialName("member_status") val memberStatus: String?,
        @SerialName("team_role") val teamRole: String?,
        @SerialName("agent_kind") val agentKind: String?,
        @SerialName("agent_status") val agentStatus: String?,
    )

    @Serializable
    private data class InviteRow(
        val token: String,
        @SerialName("expires_at") val expiresAt: Instant,
        val deeplink: String,
    )
}
