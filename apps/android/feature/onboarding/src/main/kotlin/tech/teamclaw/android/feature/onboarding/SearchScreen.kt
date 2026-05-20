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
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import tech.teamclaw.android.core.design.Hai
import tech.teamclaw.android.core.model.ActorRecord
import tech.teamclaw.android.core.model.IdeaRecord
import tech.teamclaw.android.core.model.SearchMatcher
import tech.teamclaw.android.core.model.SessionRecord

/**
 * Port of iOS `Root/SearchTab.swift`. Global search across sessions,
 * ideas, and actors. Empty query shows a Hai prompt; otherwise three
 * sections render only when they have matches.
 */
@Composable
fun SearchScreen(
    sessions: List<SessionRecord>,
    ideas: List<IdeaRecord>,
    actors: List<ActorRecord>,
    onOpenSession: (SessionRecord) -> Unit,
    onOpenIdea: (IdeaRecord) -> Unit,
    onOpenActor: (ActorRecord) -> Unit,
    modifier: Modifier = Modifier,
) {
    var query by remember { mutableStateOf("") }
    val trimmedQuery = remember(query) { query.trim() }

    val sessionMatches = remember(sessions, trimmedQuery) {
        if (trimmedQuery.isEmpty()) emptyList()
        else sessions.filter {
            SearchMatcher.matchesAny(
                listOf(it.title, it.summary, it.lastMessagePreview),
                trimmedQuery,
            )
        }
    }
    val ideaMatches = remember(ideas, trimmedQuery) {
        if (trimmedQuery.isEmpty()) emptyList()
        else ideas.filter {
            SearchMatcher.matchesAny(listOf(it.title, it.description), trimmedQuery)
        }
    }
    val actorMatches = remember(actors, trimmedQuery) {
        if (trimmedQuery.isEmpty()) emptyList()
        else actors.filter { SearchMatcher.matches(it.displayName, trimmedQuery) }
    }

    Column(modifier = modifier.fillMaxSize().background(Hai.Mist)) {
        SearchTopBar(query = query, onQueryChange = { query = it })

        if (trimmedQuery.isEmpty()) {
            EmptyState(
                title = "Search",
                subtitle = "Search sessions, ideas, and actors.",
                testTag = "search.empty",
            )
        } else if (sessionMatches.isEmpty() && ideaMatches.isEmpty() && actorMatches.isEmpty()) {
            EmptyState(
                title = "No Results",
                subtitle = "No matches for \"$trimmedQuery\".",
                testTag = "search.noResults",
            )
        } else {
            LazyColumn(modifier = Modifier.fillMaxSize().testTag("search.results")) {
                if (sessionMatches.isNotEmpty()) {
                    item("section.sessions") { SectionHeader("Sessions") }
                    items(sessionMatches, key = { "s:${it.id}" }) { session ->
                        SessionResultRow(session, onClick = { onOpenSession(session) })
                        HorizontalDivider(color = Hai.Hairline)
                    }
                }
                if (ideaMatches.isNotEmpty()) {
                    item("section.ideas") { SectionHeader("Ideas") }
                    items(ideaMatches, key = { "i:${it.id}" }) { idea ->
                        IdeaResultRow(idea, onClick = { onOpenIdea(idea) })
                        HorizontalDivider(color = Hai.Hairline)
                    }
                }
                if (actorMatches.isNotEmpty()) {
                    item("section.actors") { SectionHeader("Actors") }
                    items(actorMatches, key = { "a:${it.id}" }) { actor ->
                        ActorResultRow(actor, onClick = { onOpenActor(actor) })
                        HorizontalDivider(color = Hai.Hairline)
                    }
                }
            }
        }
    }
}

@Composable
private fun SearchTopBar(query: String, onQueryChange: (String) -> Unit) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
        Text(
            text = "Search",
            style = MaterialTheme.typography.headlineMedium,
            color = Hai.Onyx,
            modifier = Modifier.padding(bottom = 12.dp),
        )
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(Hai.Paper)
                .padding(horizontal = 12.dp, vertical = 10.dp)
                .testTag("search.input"),
            contentAlignment = Alignment.CenterStart,
        ) {
            BasicTextField(
                value = query,
                onValueChange = onQueryChange,
                modifier = Modifier.fillMaxWidth(),
                textStyle = TextStyle(
                    color = Hai.Onyx,
                    fontFamily = FontFamily.SansSerif,
                    fontSize = 15.sp,
                ),
                cursorBrush = androidx.compose.ui.graphics.SolidColor(Hai.Cinnabar),
                decorationBox = { inner ->
                    if (query.isEmpty()) {
                        Text(
                            "⌕ Sessions, ideas, actors",
                            color = Hai.Slate,
                            fontSize = 15.sp,
                        )
                    }
                    inner()
                },
            )
        }
    }
}

@Composable
private fun SectionHeader(title: String) {
    Text(
        text = title.uppercase(),
        modifier = Modifier
            .fillMaxWidth()
            .background(Hai.Mist)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        color = Hai.Basalt.copy(alpha = 0.7f),
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 11.sp,
        letterSpacing = 0.6.sp,
    )
}

@Composable
private fun SessionResultRow(session: SessionRecord, onClick: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
        Text(
            text = session.title.ifBlank { "Untitled session" },
            color = Hai.Onyx,
            style = MaterialTheme.typography.labelLarge,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (session.lastMessagePreview.isNotBlank()) {
            Text(
                text = session.lastMessagePreview,
                color = Hai.Basalt,
                style = MaterialTheme.typography.bodySmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
    }
}

@Composable
private fun IdeaResultRow(idea: IdeaRecord, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            modifier = Modifier
                .padding(top = 6.dp)
                .size(8.dp)
                .clip(CircleShape)
                .background(Hai.Sage),
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = idea.displayTitle.ifEmpty { "Untitled" },
                color = Hai.Onyx,
                style = MaterialTheme.typography.labelLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = idea.statusLabel,
                color = Hai.Slate,
                fontFamily = FontFamily.SansSerif,
                fontWeight = FontWeight.SemiBold,
                fontSize = 11.sp,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
    }
}

@Composable
private fun ActorResultRow(actor: ActorRecord, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            modifier = Modifier
                .size(32.dp)
                .clip(CircleShape)
                .background(if (actor.isAgent) Hai.Sage else Hai.Cinnabar.copy(alpha = 0.18f)),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = actor.displayName.firstOrNull()?.uppercaseChar()?.toString() ?: "?",
                color = if (actor.isAgent) Color.White else Hai.Cinnabar,
                fontFamily = FontFamily.SansSerif,
                fontWeight = FontWeight.SemiBold,
                fontSize = 13.sp,
            )
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = actor.displayName,
                color = Hai.Onyx,
                style = MaterialTheme.typography.labelLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = if (actor.isAgent) "Agent · ${actor.agentKind ?: "—"}" else actor.roleLabel,
                color = Hai.Basalt,
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

@Composable
private fun EmptyState(title: String, subtitle: String, testTag: String) {
    Box(
        modifier = Modifier.fillMaxSize().testTag(testTag),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(horizontal = 32.dp),
        ) {
            Text(
                text = "⌕",
                color = Hai.Slate,
                fontSize = 32.sp,
                fontFamily = FontFamily.SansSerif,
            )
            Spacer(Modifier.size(16.dp))
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
