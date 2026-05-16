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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.ClipboardManager
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import tech.teamclaw.android.core.design.Hai
import tech.teamclaw.android.core.design.TeamclawTheme
import tech.teamclaw.android.core.model.ActorRecord
import tech.teamclaw.android.core.model.InviteCreated

@Composable
fun ActorDetailScreen(
    actor: ActorRecord,
    rotatedInvite: InviteCreated?,
    isBusy: Boolean,
    errorMessage: String?,
    onBack: () -> Unit,
    onRotate: () -> Unit,
    onRemove: () -> Unit,
    onDismissInvite: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var confirmRemove by remember { mutableStateOf(false) }
    val clipboard: ClipboardManager = LocalClipboardManager.current

    Column(modifier = modifier.fillMaxSize().background(Hai.Mist)) {
        TopBar(onBack = onBack, title = actor.displayName)

        Column(
            modifier = Modifier.fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            HeaderCard(actor = actor)
            DetailsCard(actor = actor)

            if (rotatedInvite != null) {
                RotatedInviteCard(
                    invite = rotatedInvite,
                    onCopy = { clipboard.setText(AnnotatedString(rotatedInvite.deeplink)) },
                    onDismiss = onDismissInvite,
                )
            }

            if (!errorMessage.isNullOrEmpty()) {
                Box(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
                        .background(Hai.Cinnabar.copy(alpha = 0.10f)).padding(12.dp),
                ) {
                    Text(errorMessage, style = MaterialTheme.typography.bodySmall, color = Hai.Onyx)
                }
            }

            OutlinedButton(
                onClick = onRotate,
                enabled = !isBusy,
                modifier = Modifier.fillMaxWidth().testTag("actorDetail.rotateButton"),
                shape = RoundedCornerShape(14.dp),
            ) {
                Text(if (isBusy) "Generating…" else "Rotate credentials")
            }

            Button(
                onClick = { confirmRemove = true },
                enabled = !isBusy,
                modifier = Modifier.fillMaxWidth().testTag("actorDetail.removeButton"),
                shape = RoundedCornerShape(14.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Hai.CinnabarDeep),
            ) {
                Text(
                    if (actor.isAgent) "Remove agent from team" else "Remove member from team",
                    color = androidx.compose.ui.graphics.Color.White,
                )
            }
        }
    }

    if (confirmRemove) {
        AlertDialog(
            onDismissRequest = { confirmRemove = false },
            title = { Text(if (actor.isAgent) "Remove agent?" else "Remove member?") },
            text = {
                Text(
                    "This deletes ${actor.displayName} from the team. " +
                        "Existing sessions stay readable but the actor can't post new messages.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmRemove = false
                    onRemove()
                }) {
                    Text("Remove", color = Hai.CinnabarDeep)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmRemove = false }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun TopBar(onBack: () -> Unit, title: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(onClick = onBack) { Text("Back", color = Hai.Cinnabar) }
        Text(
            title,
            modifier = Modifier.weight(1f),
            style = MaterialTheme.typography.titleLarge, color = Hai.Onyx,
            maxLines = 1,
        )
        Spacer(Modifier.size(72.dp))
    }
}

@Composable
private fun HeaderCard(actor: ActorRecord) {
    Row(
        modifier = Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(Hai.Paper)
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            Modifier.size(48.dp).clip(CircleShape)
                .background(if (actor.isAgent) Hai.Sage else Hai.Cinnabar.copy(alpha = 0.18f)),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                actor.displayName.firstOrNull()?.uppercaseChar()?.toString() ?: "?",
                style = MaterialTheme.typography.titleLarge,
                color = if (actor.isAgent) androidx.compose.ui.graphics.Color.White else Hai.Cinnabar,
            )
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(actor.displayName, style = MaterialTheme.typography.titleLarge, color = Hai.Onyx)
            Text(
                if (actor.isAgent) "Agent · ${actor.agentKind ?: "—"}" else actor.roleLabel,
                style = MaterialTheme.typography.bodyMedium, color = Hai.Basalt,
            )
        }
        if (actor.isOnline) {
            Box(Modifier.size(10.dp).clip(CircleShape).background(Hai.Sage))
        }
    }
}

@Composable
private fun DetailsCard(actor: ActorRecord) {
    Column(
        modifier = Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(Hai.Paper)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        DetailRow("Actor ID", actor.id)
        DetailRow("Type", if (actor.isAgent) "Agent" else "Member")
        if (actor.isAgent) DetailRow("Kind", actor.agentKind ?: "—")
        actor.memberStatus?.let { DetailRow("Status", it) }
        actor.userId?.let { DetailRow("User", it) }
    }
}

@Composable
private fun DetailRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = Hai.Basalt)
        Text(value, style = MaterialTheme.typography.bodyMedium, color = Hai.Onyx, maxLines = 1)
    }
    HorizontalDivider(color = Hai.Hairline)
}

@Composable
private fun RotatedInviteCard(
    invite: InviteCreated,
    onCopy: () -> Unit,
    onDismiss: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(Hai.Pebble)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("New invite link", style = MaterialTheme.typography.labelLarge, color = Hai.Onyx)
        Text(
            invite.deeplink,
            style = MaterialTheme.typography.bodySmall, color = Hai.Basalt,
            maxLines = 3,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = onCopy,
                shape = RoundedCornerShape(14.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Hai.Cinnabar),
                modifier = Modifier.weight(1f),
            ) { Text("Copy link") }
            TextButton(onClick = onDismiss) { Text("Dismiss", color = Hai.Basalt) }
        }
    }
}

@Preview
@Composable
private fun ActorDetailPreview() {
    TeamclawTheme {
        ActorDetailScreen(
            actor = ActorRecord("1", "T", "agent", null, null, "Codex",
                System.currentTimeMillis(), 0L, 0L, null, null, "codex", "online"),
            rotatedInvite = null,
            isBusy = false, errorMessage = null,
            onBack = {}, onRotate = {}, onRemove = {}, onDismissInvite = {},
        )
    }
}
