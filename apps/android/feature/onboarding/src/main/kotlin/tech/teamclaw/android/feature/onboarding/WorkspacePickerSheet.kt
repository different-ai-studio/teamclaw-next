package tech.teamclaw.android.feature.onboarding

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import tech.teamclaw.android.core.design.Hai
import tech.teamclaw.android.core.design.HaiHairline
import tech.teamclaw.android.core.design.HaiPaperCard
import tech.teamclaw.android.core.design.HaiSectionLabel
import tech.teamclaw.android.core.model.WorkspaceRecord

/**
 * Hai-styled workspace selector — reused by [NewIdeaSheet] and
 * [IdeaDetailScreen]. Pebble sheet + paper card with hairline-separated
 * rows; the selected workspace gets a Cinnabar checkmark.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspacePickerSheet(
    workspaces: List<WorkspaceRecord>,
    selectedId: String,
    onSelect: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        sheetState = sheetState,
        onDismissRequest = onDismiss,
        containerColor = Hai.Pebble,
        scrimColor = Hai.Onyx.copy(alpha = 0.30f),
        dragHandle = null,
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
            HaiSectionLabel(title = "Select Workspace")
            Spacer(Modifier.heightIn(min = 8.dp))
            HaiPaperCard {
                workspaces.forEachIndexed { index, ws ->
                    if (index > 0) HaiHairline()
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onSelect(ws.id) }
                            .padding(horizontal = 14.dp, vertical = 13.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                ws.displayName,
                                color = Hai.Onyx,
                                style = MaterialTheme.typography.labelLarge,
                            )
                            if (ws.path.isNotBlank()) {
                                Text(
                                    ws.path,
                                    color = Hai.Basalt.copy(alpha = 0.6f),
                                    fontFamily = FontFamily.Monospace,
                                    fontSize = 12.sp,
                                )
                            }
                        }
                        if (ws.id == selectedId) {
                            Text("✓", color = Hai.Cinnabar, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }
        }
    }
}
