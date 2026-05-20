package tech.teamclaw.android.core.design

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Pill-style segmented filter — port of iOS `Shared/SegmentedFilterBar.swift`.
 *
 *   Track: Hai.Pebble @ 55% opacity, 999dp capsule
 *   Active pill: Hai.Onyx fill, white text + monospaced count
 *   Inactive pill: transparent on track, Basalt text + Slate count
 *
 * Counts are optional; pass `count = null` for "All / Mine / Open / Done"
 * style lists until totals are known.
 */
data class HaiSegment<T>(
    val tag: T,
    val title: String,
    val count: Int? = null,
)

@Composable
fun <T> HaiSegmentedFilterBar(
    segments: List<HaiSegment<T>>,
    selection: T,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(999.dp))
            .background(Hai.Pebble.copy(alpha = 0.55f))
            .padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        segments.forEach { segment ->
            HaiSegmentPill(
                segment = segment,
                isActive = segment.tag == selection,
                onClick = { onSelect(segment.tag) },
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
private fun <T> HaiSegmentPill(
    segment: HaiSegment<T>,
    isActive: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val pillShape = RoundedCornerShape(999.dp)
    Row(
        modifier = modifier
            .clip(pillShape)
            .background(if (isActive) Hai.Onyx else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = segment.title,
            color = if (isActive) Color.White else Hai.Basalt,
            fontFamily = FontFamily.SansSerif,
            fontWeight = FontWeight.SemiBold,
            fontSize = 14.sp,
        )
        if (segment.count != null) {
            Text(
                text = " · ",
                color = if (isActive) Color.White.copy(alpha = 0.65f) else Hai.Slate,
                fontSize = 13.sp,
            )
            Text(
                text = "${segment.count}",
                color = if (isActive) Color.White.copy(alpha = 0.70f) else Hai.Slate,
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Normal,
                fontSize = 13.sp,
            )
        }
    }
}
