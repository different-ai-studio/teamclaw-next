package tech.teamclaw.android.feature.onboarding

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import tech.teamclaw.android.core.design.Hai
import tech.teamclaw.android.core.design.HaiSegment
import tech.teamclaw.android.core.design.HaiSegmentedFilterBar
import tech.teamclaw.android.core.design.TeamclawTheme
import tech.teamclaw.android.core.model.ActorRecord
import tech.teamclaw.android.core.model.IdeaRecord
import tech.teamclaw.android.core.model.IdeaStatus

/**
 * Port of iOS `Collab/IdeaListView.swift`. Renders the Hai Ideas list with
 * the All / Mine / Open / Done segmented filter, the archived-count footer
 * row, and the "+ New" header CTA.
 */
enum class IdeaListFilter { ALL, MINE, OPEN, DONE }

@Composable
fun IdeaListScreen(
    ideas: List<IdeaRecord>,
    archivedCount: Int,
    actors: List<ActorRecord>,
    currentActorId: String?,
    isLoading: Boolean,
    errorMessage: String?,
    onRefresh: () -> Unit,
    onOpenIdea: (IdeaRecord) -> Unit,
    onArchive: (IdeaRecord) -> Unit,
    onOpenArchived: () -> Unit,
    onNewIdea: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val actorById = remember(actors) { actors.associateBy { it.id } }
    var filter by rememberSaveable { mutableStateOf(IdeaListFilter.ALL) }

    val filtered = remember(ideas, filter, currentActorId) {
        when (filter) {
            IdeaListFilter.ALL -> ideas
            IdeaListFilter.MINE ->
                if (currentActorId.isNullOrEmpty()) emptyList()
                else ideas.filter { it.createdByActorId == currentActorId }
            IdeaListFilter.OPEN -> ideas.filter { it.status == IdeaStatus.OPEN }
            IdeaListFilter.DONE -> ideas.filter { it.status == IdeaStatus.DONE }
        }
    }

    val segments = remember(ideas, currentActorId) {
        buildList {
            add(HaiSegment(IdeaListFilter.ALL, "All", ideas.size))
            if (!currentActorId.isNullOrEmpty()) {
                add(
                    HaiSegment(
                        IdeaListFilter.MINE,
                        "Mine",
                        ideas.count { it.createdByActorId == currentActorId },
                    ),
                )
            }
            add(HaiSegment(IdeaListFilter.OPEN, "Open", ideas.count { it.status == IdeaStatus.OPEN }))
            add(HaiSegment(IdeaListFilter.DONE, "Done", ideas.count { it.status == IdeaStatus.DONE }))
        }
    }

    Column(modifier = modifier.fillMaxSize().background(Hai.Mist)) {
        IdeaListTopBar(onRefresh = onRefresh, onNewIdea = onNewIdea)

        if (!errorMessage.isNullOrEmpty() && ideas.isEmpty()) {
            ContentUnavailable(
                title = "Couldn't Load Ideas",
                subtitle = errorMessage,
                modifier = Modifier.weight(1f),
            )
        } else if (isLoading && ideas.isEmpty()) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = Hai.Cinnabar)
            }
        } else if (ideas.isEmpty()) {
            ContentUnavailable(
                title = "No Ideas",
                subtitle = "Tap + to create an idea",
                modifier = Modifier.weight(1f),
            )
        } else {
            HaiSegmentedFilterBar(
                segments = segments,
                selection = filter,
                onSelect = { filter = it },
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 8.dp),
            )
            if (filtered.isEmpty()) {
                ContentUnavailable(
                    title = emptyTitle(filter),
                    subtitle = emptySubtitle(filter),
                    modifier = Modifier.weight(1f),
                )
            } else {
                LazyColumn(modifier = Modifier.weight(1f).fillMaxWidth().testTag("ideas.list")) {
                    items(filtered, key = { it.id }) { idea ->
                        IdeaRow(
                            idea = idea,
                            creatorName = actorById[idea.createdByActorId]?.displayName,
                            onClick = { onOpenIdea(idea) },
                            onArchive = { onArchive(idea) },
                        )
                        HorizontalDivider(color = Hai.Hairline)
                    }
                }
            }
        }

        if (archivedCount > 0) {
            HorizontalDivider(color = Hai.Hairline)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(onClick = onOpenArchived)
                    .padding(horizontal = 16.dp, vertical = 14.dp)
                    .testTag("ideas.archivedButton"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "Archived ($archivedCount)",
                    color = Hai.Basalt,
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.weight(1f),
                )
                Text("›", color = Hai.Slate, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Composable
private fun IdeaListTopBar(onRefresh: () -> Unit, onNewIdea: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = "Ideas",
            style = MaterialTheme.typography.headlineMedium,
            color = Hai.Onyx,
            modifier = Modifier.weight(1f),
        )
        TextButton(onClick = onRefresh) { Text("Refresh", color = Hai.Cinnabar) }
        TextButton(
            onClick = onNewIdea,
            modifier = Modifier.testTag("ideas.newButton"),
        ) {
            Text("+ New", color = Hai.Cinnabar, style = MaterialTheme.typography.labelLarge)
        }
    }
}

@Composable
private fun IdeaRow(
    idea: IdeaRecord,
    creatorName: String?,
    onClick: () -> Unit,
    onArchive: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        StatusDot(idea.status)
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = idea.displayTitle.ifEmpty { "Untitled" },
                color = Hai.Onyx,
                style = MaterialTheme.typography.labelLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (idea.description.isNotBlank() && idea.title.isNotBlank()) {
                Text(
                    text = idea.description,
                    color = Hai.Basalt,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
            Row(modifier = Modifier.padding(top = 4.dp)) {
                Text(
                    text = idea.statusLabel,
                    color = Hai.Slate,
                    fontFamily = FontFamily.SansSerif,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 11.sp,
                )
                if (creatorName != null) {
                    Text(
                        text = " · $creatorName",
                        color = Hai.Slate,
                        fontFamily = FontFamily.SansSerif,
                        fontSize = 11.sp,
                    )
                }
            }
        }
        // Material 3 does not include a built-in swipe-to-archive primitive
        // in stable channels; expose archive as a tap target for now. Phase
        // 4 will add a `SwipeToDismissBox` once we adopt 1.3 stable.
        Box(
            modifier = Modifier
                .size(34.dp)
                .clip(RoundedCornerShape(8.dp))
                .clickable(onClick = onArchive)
                .testTag("ideas.row.archive"),
            contentAlignment = Alignment.Center,
        ) {
            Text(text = "▦", color = Hai.Slate, fontSize = 16.sp)
        }
    }
}

@Composable
private fun StatusDot(status: String) {
    val color = when (status) {
        IdeaStatus.OPEN -> Hai.Sage
        IdeaStatus.IN_PROGRESS -> Hai.Cinnabar
        IdeaStatus.DONE -> Hai.Slate
        else -> Hai.Slate
    }
    Box(
        modifier = Modifier
            .size(10.dp)
            .clip(CircleShape)
            .background(color)
            .padding(top = 6.dp),
    )
}

@Composable
private fun ContentUnavailable(title: String, subtitle: String, modifier: Modifier = Modifier) {
    Box(modifier = modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(horizontal = 32.dp),
        ) {
            Text(title, color = Hai.Onyx, style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.size(8.dp))
            Text(
                subtitle,
                color = Hai.Basalt,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

private fun emptyTitle(filter: IdeaListFilter): String = when (filter) {
    IdeaListFilter.ALL -> "No Ideas"
    IdeaListFilter.MINE -> "Nothing here yet"
    IdeaListFilter.OPEN -> "No open ideas"
    IdeaListFilter.DONE -> "No completed ideas"
}

private fun emptySubtitle(filter: IdeaListFilter): String = when (filter) {
    IdeaListFilter.ALL -> "Tap + to create an idea"
    IdeaListFilter.MINE -> "Ideas you create will show up here"
    IdeaListFilter.OPEN -> "Open ideas will appear once created"
    IdeaListFilter.DONE -> "Mark an idea as Done to see it here"
}

@Preview
@Composable
private fun IdeaListPreview() {
    TeamclawTheme {
        IdeaListScreen(
            ideas = listOf(
                IdeaRecord(
                    id = "1", teamId = "t", workspaceId = "ws",
                    createdByActorId = "a1",
                    title = "Rename collab to Ideas",
                    description = "Make the navigation consistent across apps",
                    status = IdeaStatus.IN_PROGRESS, archived = false,
                    createdAtMs = 0L, updatedAtMs = 0L,
                ),
                IdeaRecord(
                    id = "2", teamId = "t", workspaceId = "ws",
                    createdByActorId = "a2",
                    title = "", description = "Investigate the new Hai paper card spacing",
                    status = IdeaStatus.OPEN, archived = false,
                    createdAtMs = 0L, updatedAtMs = 0L,
                ),
            ),
            archivedCount = 3,
            actors = listOf(
                ActorRecord("a1", "T", "member", "u", null, "Alice",
                    null, 0L, 0L, "active", "owner", null, null),
            ),
            currentActorId = "a1",
            isLoading = false,
            errorMessage = null,
            onRefresh = {},
            onOpenIdea = {},
            onArchive = {},
            onOpenArchived = {},
            onNewIdea = {},
        )
    }
}
