package tech.teamclaw.android.feature.onboarding

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import tech.teamclaw.android.core.design.Hai
import tech.teamclaw.android.core.design.TeamclawTheme
import tech.teamclaw.android.core.model.ActorRecord

@Composable
fun MembersScreen(
    teamName: String,
    actors: List<ActorRecord>,
    isLoading: Boolean,
    errorMessage: String?,
    onRefresh: () -> Unit,
    onInvite: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxSize().background(Hai.Mist)) {
        MembersTopBar(teamName, onBack, onRefresh, onInvite)

        if (!errorMessage.isNullOrEmpty()) {
            Box(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)
                    .clip(RoundedCornerShape(10.dp)).background(Hai.Cinnabar.copy(alpha = 0.10f))
                    .padding(12.dp),
            ) {
                Text(errorMessage, style = MaterialTheme.typography.bodySmall, color = Hai.Onyx)
            }
        }

        if (isLoading && actors.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = Hai.Cinnabar)
            }
        } else if (actors.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("No members yet.", style = MaterialTheme.typography.bodyLarge, color = Hai.Basalt)
            }
        } else {
            LazyColumn(modifier = Modifier.fillMaxSize().testTag("members.list")) {
                items(items = actors, key = { it.id }) { actor ->
                    ActorRow(actor)
                    HorizontalDivider(color = Hai.Hairline)
                }
            }
        }
    }
}

@Composable
private fun MembersTopBar(
    teamName: String, onBack: () -> Unit, onRefresh: () -> Unit, onInvite: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(onClick = onBack) { Text("Back", color = Hai.Cinnabar) }
        Column(modifier = Modifier.weight(1f)) {
            Text("Actors", style = MaterialTheme.typography.titleLarge, color = Hai.Onyx)
            Text(teamName, style = MaterialTheme.typography.bodySmall, color = Hai.Basalt)
        }
        TextButton(onClick = onRefresh) { Text("Refresh", color = Hai.Cinnabar) }
        Button(
            onClick = onInvite,
            shape = RoundedCornerShape(14.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Hai.Cinnabar),
            modifier = Modifier.testTag("members.inviteButton"),
        ) { Text("Invite") }
    }
}

@Composable
private fun ActorRow(actor: ActorRecord) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            modifier = Modifier.size(38.dp).clip(CircleShape)
                .background(if (actor.isAgent) Hai.Sage else Hai.Cinnabar.copy(alpha = 0.18f)),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = actor.displayName.firstOrNull()?.uppercaseChar()?.toString() ?: "?",
                style = MaterialTheme.typography.labelLarge,
                color = if (actor.isAgent) androidx.compose.ui.graphics.Color.White else Hai.Cinnabar,
            )
        }
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    actor.displayName,
                    style = MaterialTheme.typography.labelLarge,
                    color = Hai.Onyx,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (actor.isOnline) {
                    Spacer(Modifier.size(6.dp))
                    Box(Modifier.size(8.dp).clip(CircleShape).background(Hai.Sage))
                }
            }
            Text(
                text = if (actor.isAgent) "Agent · ${actor.agentKind ?: "—"}" else actor.roleLabel,
                style = MaterialTheme.typography.bodySmall,
                color = Hai.Basalt,
            )
        }
    }
}

@Preview
@Composable
private fun MembersPreview() {
    TeamclawTheme {
        MembersScreen(
            teamName = "Quiet Harbor",
            actors = listOf(
                ActorRecord("1", "T", "member", "u1", null, "Alice",
                    null, 0L, 0L, "active", "owner", null, null),
                ActorRecord("2", "T", "agent", null, "1", "Codex",
                    System.currentTimeMillis(), 0L, 0L, null, null, "codex", "online"),
            ),
            isLoading = false, errorMessage = null,
            onRefresh = {}, onInvite = {}, onBack = {},
        )
    }
}
