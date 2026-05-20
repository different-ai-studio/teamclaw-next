package tech.teamclaw.android.core.design

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Hai sheet primitives — Kotlin/Compose port of iOS `Shared/HaiSheet.swift`.
 *
 *   Pebble sheet background  →  HaiPaperCard (paper fill) on top
 *   Section label (uppercase, tracked) precedes each card
 *   HaiSheetRow stacks inside the card with HaiHairline dividers between rows
 *
 * Cinnabar is reserved for active CTAs / unread dots — never used here.
 */

@Composable
fun HaiSectionLabel(
    title: String,
    modifier: Modifier = Modifier,
) {
    Text(
        text = title.uppercase(),
        modifier = modifier.padding(horizontal = 24.dp),
        color = Hai.Basalt.copy(alpha = 0.70f),
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 11.sp,
        letterSpacing = 0.6.sp,
    )
}

/**
 * Standard Hai paper card: 14dp radius, Hai.Paper fill, 16dp horizontal inset.
 * Stack [HaiSheetRow]s inside this card; insert [HaiHairline] between rows.
 */
@Composable
fun HaiPaperCard(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Column(
        modifier = modifier
            .padding(horizontal = 16.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(Hai.Paper),
    ) { content() }
}

/**
 * Reusable Hai sheet row: left label, right value, optional chevron.
 */
@Composable
fun HaiSheetRow(
    label: String,
    modifier: Modifier = Modifier,
    value: String? = null,
    valueIsMonospaced: Boolean = false,
    valueIsMuted: Boolean = false,
    showsChevron: Boolean = false,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = label,
            color = Hai.Onyx,
            fontFamily = FontFamily.SansSerif,
            fontWeight = FontWeight.Normal,
            fontSize = 14.5.sp,
        )
        Spacer(Modifier.weight(1f))
        Spacer(Modifier.width(8.dp))
        if (value != null) {
            Text(
                text = value,
                color = if (valueIsMuted) Hai.Basalt.copy(alpha = 0.6f) else Hai.Basalt,
                fontFamily = if (valueIsMonospaced) FontFamily.Monospace else FontFamily.SansSerif,
                fontWeight = FontWeight.Normal,
                fontSize = 14.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (showsChevron) {
            Text(
                text = "›",
                color = Hai.Slate,
                fontFamily = FontFamily.SansSerif,
                fontWeight = FontWeight.SemiBold,
                fontSize = 16.sp,
            )
        }
    }
}

/**
 * Hairline divider — 0.5dp Hai.Hairline. Use between [HaiSheetRow]s.
 */
@Composable
fun HaiHairline(modifier: Modifier = Modifier) {
    HorizontalDivider(
        modifier = modifier.padding(horizontal = 14.dp),
        thickness = 0.5.dp,
        color = Hai.Hairline,
    )
}
