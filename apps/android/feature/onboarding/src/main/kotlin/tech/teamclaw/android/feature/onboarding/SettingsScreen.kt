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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import tech.teamclaw.android.core.design.Hai
import tech.teamclaw.android.core.design.TeamclawTheme

data class SettingsViewState(
    val teamName: String,
    val teamRole: String,
    val displayName: String,
    val isAnonymous: Boolean,
    val versionName: String,
    val versionCode: Int,
)

@Composable
fun SettingsScreen(
    state: SettingsViewState,
    onBack: () -> Unit,
    onUpgradeAccount: () -> Unit,
    onSignOut: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxSize().background(Hai.Mist).verticalScroll(rememberScrollState())) {
        SettingsTopBar(onBack = onBack)

        Section(title = "Account") {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(
                    Modifier.size(48.dp).clip(CircleShape).background(Hai.Cinnabar.copy(alpha = 0.18f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        state.displayName.firstOrNull()?.uppercaseChar()?.toString() ?: "?",
                        style = MaterialTheme.typography.titleLarge, color = Hai.Cinnabar,
                    )
                }
                Column(modifier = Modifier.weight(1f)) {
                    Text(state.displayName.ifBlank { "Anonymous" },
                         style = MaterialTheme.typography.labelLarge, color = Hai.Onyx)
                    Text(
                        if (state.isAnonymous) "Private workspace (anonymous)"
                        else "Signed in",
                        style = MaterialTheme.typography.bodySmall, color = Hai.Basalt,
                    )
                }
            }
            if (state.isAnonymous) {
                Spacer(Modifier.size(8.dp))
                OutlinedButton(
                    onClick = onUpgradeAccount,
                    modifier = Modifier.fillMaxWidth().testTag("settings.upgradeButton"),
                    shape = RoundedCornerShape(14.dp),
                ) { Text("Upgrade to a permanent account") }
            }
        }

        Section(title = "Team") {
            SettingsRow(label = "Team", value = state.teamName)
            SettingsRow(label = "Role", value = state.teamRole)
        }

        Section(title = "About") {
            SettingsRow(label = "Version", value = "${state.versionName} (${state.versionCode})")
            SettingsRow(label = "Build", value = "Android · debug")
        }

        Spacer(Modifier.size(24.dp))
        Button(
            onClick = onSignOut,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("settings.signOutButton"),
            shape = RoundedCornerShape(18.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Hai.CinnabarDeep),
        ) { Text("Sign out") }

        Spacer(Modifier.size(32.dp))
    }
}

@Composable
private fun SettingsTopBar(onBack: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(onClick = onBack) { Text("Back", color = Hai.Cinnabar) }
        Text(
            "Settings",
            modifier = Modifier.weight(1f).padding(start = 4.dp),
            style = MaterialTheme.typography.titleLarge, color = Hai.Onyx,
        )
        Spacer(Modifier.size(72.dp))
    }
}

@Composable
private fun Section(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        Text(title.uppercase(), style = MaterialTheme.typography.bodySmall, color = Hai.Slate)
        Spacer(Modifier.size(8.dp))
        Column(
            modifier = Modifier.fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .background(Hai.Paper)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            content()
        }
    }
}

@Composable
private fun SettingsRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = Hai.Basalt)
        Text(value, style = MaterialTheme.typography.bodyMedium, color = Hai.Onyx)
    }
    HorizontalDivider(color = Hai.Hairline)
}

private typealias ColumnScope = androidx.compose.foundation.layout.ColumnScope

@Preview
@Composable
private fun SettingsPreview() {
    TeamclawTheme {
        SettingsScreen(
            state = SettingsViewState(
                teamName = "Quiet Harbor", teamRole = "Owner",
                displayName = "matt.chow", isAnonymous = false,
                versionName = "1.1.5", versionCode = 1,
            ),
            onBack = {}, onUpgradeAccount = {}, onSignOut = {},
        )
    }
}
