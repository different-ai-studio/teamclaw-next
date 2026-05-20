package tech.teamclaw.android.feature.onboarding

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import tech.teamclaw.android.core.design.Hai

/**
 * Placeholder used by the Search tab until Phase 7 lands. The Ideas
 * placeholder has been replaced by [IdeaListScreen] (Phase 1 — PR for
 * the Ideas feature). The empty-state copy mirrors the iOS
 * `ContentUnavailableView` voice.
 */

@Composable
fun SearchTabPlaceholder(modifier: Modifier = Modifier) {
    TabPlaceholderContent(
        glyph = "⌕",
        title = "Search",
        subtitle = "Find sessions, ideas, and actors. Coming soon on Android.",
        testTag = "search.placeholder",
        modifier = modifier,
    )
}

@Composable
private fun TabPlaceholderContent(
    glyph: String,
    title: String,
    subtitle: String,
    testTag: String,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Hai.Mist)
            .testTag(testTag),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
            modifier = Modifier.padding(horizontal = 32.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(72.dp)
                    .background(Hai.Pebble.copy(alpha = 0.5f), shape = CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = glyph,
                    color = Hai.Slate,
                    fontSize = 32.sp,
                    fontFamily = FontFamily.SansSerif,
                )
            }
            Spacer(Modifier.size(20.dp))
            Text(
                text = title,
                color = Hai.Onyx,
                fontFamily = FontFamily.Serif,
                fontWeight = FontWeight.Normal,
                fontSize = 26.sp,
            )
            Spacer(Modifier.size(8.dp))
            Text(
                text = subtitle,
                color = Hai.Basalt,
                fontFamily = FontFamily.SansSerif,
                fontWeight = FontWeight.Normal,
                fontSize = 14.sp,
            )
        }
    }
}
