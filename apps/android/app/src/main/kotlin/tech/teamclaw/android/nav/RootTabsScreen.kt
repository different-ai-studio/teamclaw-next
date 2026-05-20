package tech.teamclaw.android.nav

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import tech.teamclaw.android.core.auth.ActorStore
import tech.teamclaw.android.core.auth.OnboardingCoordinator
import tech.teamclaw.android.core.auth.SessionListStore
import tech.teamclaw.android.core.auth.WorkspaceStore
import tech.teamclaw.android.core.design.Hai
import tech.teamclaw.android.core.model.ActorRecord
import tech.teamclaw.android.core.model.SessionRecord
import tech.teamclaw.android.core.model.TeamSummary
import tech.teamclaw.android.feature.onboarding.IdeasTabPlaceholder
import tech.teamclaw.android.feature.onboarding.MembersScreen
import tech.teamclaw.android.feature.onboarding.NewSessionSheet
import tech.teamclaw.android.feature.onboarding.SearchTabPlaceholder
import tech.teamclaw.android.feature.onboarding.SessionListScreen

/**
 * Root tabs (4) — port of iOS `RootTabView.swift`:
 *   1) Sessions  2) Ideas  3) Actors  4) Search
 *
 * Shortcuts is *not* a top-level tab on iOS (it lives in the Sessions
 * drawer), so we omit it here too. See `apps/android/PARITY.md`.
 *
 * The session detail screen is rendered *above* the tab bar — when a
 * session is opened, the host (TeamclawNavHost) takes over and renders
 * SessionDetailScreen full-bleed without this tab shell.
 */
enum class RootTab { Sessions, Ideas, Actors, Search }

@Composable
fun RootTabsScreen(
    coordinator: OnboardingCoordinator,
    team: TeamSummary,
    @Suppress("UNUSED_PARAMETER") currentActorId: String,
    sessionListStore: SessionListStore,
    actorStore: ActorStore,
    workspaceStore: WorkspaceStore,
    onOpenSession: (SessionRecord) -> Unit,
    onOpenSettings: () -> Unit,
    onOpenActorDetail: (ActorRecord) -> Unit,
    onInviteMember: () -> Unit,
    onSignOut: () -> Unit,
) {
    var selectedTab by rememberSaveable { mutableStateOf(RootTab.Sessions) }
    var showNewSession by remember { mutableStateOf(false) }
    val listState by sessionListStore.state.collectAsStateWithLifecycle()
    val actorState by actorStore.state.collectAsStateWithLifecycle()
    val workspaceState by workspaceStore.state.collectAsStateWithLifecycle()

    Column(modifier = Modifier.fillMaxSize().background(Hai.Mist)) {
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            when (selectedTab) {
                RootTab.Sessions -> SessionListScreen(
                    teamName = team.name,
                    sessions = listState.sessions,
                    isLoading = listState.isLoading,
                    errorMessage = listState.errorMessage,
                    onRefresh = { coordinator.launch { sessionListStore.reload() } },
                    onSessionClick = onOpenSession,
                    onSettings = onOpenSettings,
                    onNewSession = { showNewSession = true },
                    onSignOut = onSignOut,
                )
                RootTab.Ideas -> IdeasTabPlaceholder()
                RootTab.Actors -> MembersScreen(
                    teamName = team.name,
                    actors = actorState.actors,
                    isLoading = actorState.isLoading,
                    errorMessage = actorState.errorMessage,
                    onRefresh = { coordinator.launch { actorStore.reload() } },
                    onInvite = onInviteMember,
                    onActorClick = onOpenActorDetail,
                    onBack = null,
                )
                RootTab.Search -> SearchTabPlaceholder()
            }
        }

        HorizontalDivider(color = Hai.Hairline, thickness = 0.5.dp)
        HaiTabBar(selected = selectedTab, onSelect = { selectedTab = it })
    }

    if (showNewSession) {
        NewSessionSheet(
            agents = actorState.actors.filter { it.isAgent },
            workspaces = workspaceState.workspaces,
            isCreating = listState.isCreating,
            errorMessage = listState.errorMessage,
            onDismiss = { showNewSession = false },
            onSubmit = { input ->
                coordinator.launch {
                    sessionListStore.createSession(
                        title = input.title,
                        agentActorId = input.agentActorId,
                        firstMessage = input.firstMessage,
                    )
                }
            },
        )
    }
}

@Composable
private fun HaiTabBar(selected: RootTab, onSelect: (RootTab) -> Unit) {
    NavigationBar(
        modifier = Modifier.fillMaxWidth().testTag("rootTabBar"),
        containerColor = Hai.Mist,
        contentColor = Hai.Basalt,
        tonalElevation = 0.dp,
    ) {
        TabItem(
            selected = selected == RootTab.Sessions,
            icon = "💬",
            label = "Sessions",
            testTag = "tab.sessions",
            onClick = { onSelect(RootTab.Sessions) },
        )
        TabItem(
            selected = selected == RootTab.Ideas,
            icon = "✦",
            label = "Ideas",
            testTag = "tab.ideas",
            onClick = { onSelect(RootTab.Ideas) },
        )
        TabItem(
            selected = selected == RootTab.Actors,
            icon = "👥",
            label = "Actors",
            testTag = "tab.actors",
            onClick = { onSelect(RootTab.Actors) },
        )
        TabItem(
            selected = selected == RootTab.Search,
            icon = "⌕",
            label = "Search",
            testTag = "tab.search",
            onClick = { onSelect(RootTab.Search) },
        )
    }
}

@Composable
private fun RowScope.TabItem(
    selected: Boolean,
    icon: String,
    label: String,
    testTag: String,
    onClick: () -> Unit,
) {
    NavigationBarItem(
        modifier = Modifier.testTag(testTag),
        selected = selected,
        onClick = onClick,
        icon = {
            Text(
                text = icon,
                fontFamily = FontFamily.SansSerif,
                fontSize = 20.sp,
                color = if (selected) Hai.Cinnabar else Hai.Slate,
            )
        },
        label = {
            Text(
                text = label,
                fontFamily = FontFamily.SansSerif,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                fontSize = 11.sp,
                color = if (selected) Hai.Onyx else Hai.Slate,
            )
        },
        alwaysShowLabel = true,
        colors = NavigationBarItemDefaults.colors(
            selectedIconColor = Hai.Cinnabar,
            unselectedIconColor = Hai.Slate,
            selectedTextColor = Hai.Onyx,
            unselectedTextColor = Hai.Slate,
            indicatorColor = Hai.Pebble.copy(alpha = 0.4f),
        ),
    )
}
