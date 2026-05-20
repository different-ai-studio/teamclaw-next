package tech.teamclaw.android.feature.onboarding

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import tech.teamclaw.android.core.design.Hai
import tech.teamclaw.android.core.design.HaiHairline
import tech.teamclaw.android.core.design.HaiPaperCard
import tech.teamclaw.android.core.design.HaiSectionLabel
import tech.teamclaw.android.core.design.HaiSheetRow
import tech.teamclaw.android.core.model.WorkspaceRecord

/**
 * Port of iOS `CreateIdeaSheet` (apps/ios/.../Collab/IdeaSheet.swift).
 *
 * Hai discipline:
 *   - Pebble sheet background
 *   - Title + description live inside a single HaiPaperCard
 *   - Workspace selector is its own HaiPaperCard with a chevron row
 *   - Cancel / Post are circular glass icons in the toolbar
 *   - Cinnabar reserved for the Post button (active CTA only)
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewIdeaSheet(
    workspaces: List<WorkspaceRecord>,
    isSubmitting: Boolean,
    errorMessage: String?,
    onDismiss: () -> Unit,
    onSubmit: (title: String, description: String, workspaceId: String) -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    var title by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var workspaceId by remember(workspaces) {
        mutableStateOf(workspaces.firstOrNull()?.id.orEmpty())
    }
    var showWorkspacePicker by remember { mutableStateOf(false) }

    val selectedWorkspace = remember(workspaceId, workspaces) {
        workspaces.firstOrNull { it.id == workspaceId }
    }
    val canSubmit = title.isNotBlank() && !isSubmitting

    ModalBottomSheet(
        sheetState = sheetState,
        onDismissRequest = onDismiss,
        containerColor = Hai.Pebble,
        scrimColor = Hai.Onyx.copy(alpha = 0.30f),
        dragHandle = null,
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 16.dp)) {
            Toolbar(
                onCancel = {
                    scope.launch { sheetState.hide() }.invokeOnCompletion { onDismiss() }
                },
                onSubmit = {
                    if (canSubmit) onSubmit(title.trim(), description.trim(), workspaceId)
                },
                canSubmit = canSubmit,
            )
            Spacer(Modifier.heightIn(min = 4.dp))

            HaiPaperCard {
                BasicTextField(
                    value = title,
                    onValueChange = { title = it },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 14.dp, vertical = 14.dp)
                        .testTag("ideaSheet.titleField"),
                    textStyle = TextStyle(
                        color = Hai.Onyx,
                        fontFamily = FontFamily.Serif,
                        fontWeight = FontWeight.Normal,
                        fontSize = 22.sp,
                    ),
                    cursorBrush = androidx.compose.ui.graphics.SolidColor(Hai.Cinnabar),
                    decorationBox = { inner ->
                        if (title.isEmpty()) {
                            Text(
                                "Title",
                                color = Hai.Slate,
                                fontFamily = FontFamily.Serif,
                                fontSize = 22.sp,
                            )
                        }
                        inner()
                    },
                )
                HaiHairline()
                BasicTextField(
                    value = description,
                    onValueChange = { description = it },
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 120.dp)
                        .padding(horizontal = 14.dp, vertical = 14.dp)
                        .testTag("ideaSheet.descriptionField"),
                    textStyle = TextStyle(
                        color = Hai.Onyx,
                        fontFamily = FontFamily.SansSerif,
                        fontSize = 15.sp,
                    ),
                    cursorBrush = androidx.compose.ui.graphics.SolidColor(Hai.Cinnabar),
                    decorationBox = { inner ->
                        if (description.isEmpty()) {
                            Text(
                                "What needs to be decided or explored?",
                                color = Hai.Slate,
                                fontSize = 15.sp,
                            )
                        }
                        inner()
                    },
                )
            }

            Spacer(Modifier.heightIn(min = 12.dp))
            HaiSectionLabel(title = "Workspace")
            Spacer(Modifier.heightIn(min = 4.dp))
            HaiPaperCard {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .clickable(enabled = workspaces.isNotEmpty()) {
                            showWorkspacePicker = true
                        },
                ) {
                    HaiSheetRow(
                        label = selectedWorkspace?.displayName ?: "(none)",
                        value = selectedWorkspace?.path?.takeIf { it.isNotBlank() },
                        valueIsMonospaced = true,
                        valueIsMuted = true,
                        showsChevron = workspaces.isNotEmpty(),
                    )
                }
            }

            if (!errorMessage.isNullOrBlank()) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 12.dp)
                        .clip(RoundedCornerShape(10.dp))
                        .background(Hai.Cinnabar.copy(alpha = 0.10f))
                        .padding(12.dp),
                ) {
                    Text(
                        errorMessage,
                        color = Hai.Onyx,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }
    }

    if (showWorkspacePicker) {
        WorkspacePickerSheet(
            workspaces = workspaces,
            selectedId = workspaceId,
            onSelect = {
                workspaceId = it
                showWorkspacePicker = false
            },
            onDismiss = { showWorkspacePicker = false },
        )
    }
}

// NewIdeaSheet helpers below.

@Composable
private fun Toolbar(onCancel: () -> Unit, onSubmit: () -> Unit, canSubmit: Boolean) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        GlassIconButton(symbol = "✕", onClick = onCancel, modifier = Modifier.testTag("ideaSheet.cancel"))
        Text(
            "New Idea",
            color = Hai.Onyx,
            style = MaterialTheme.typography.titleLarge,
            modifier = Modifier.padding(horizontal = 12.dp).weight(1f),
        )
        GlassIconButton(
            symbol = "✓",
            onClick = onSubmit,
            enabled = canSubmit,
            primary = true,
            modifier = Modifier.testTag("ideaSheet.submit"),
        )
    }
}

@Composable
private fun GlassIconButton(
    symbol: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    primary: Boolean = false,
) {
    val bg = when {
        !enabled -> Hai.Pebble.copy(alpha = 0.4f)
        primary -> Hai.Cinnabar
        else -> Hai.Mist
    }
    val fg = when {
        !enabled -> Hai.Slate
        primary -> androidx.compose.ui.graphics.Color.White
        else -> Hai.Onyx
    }
    Box(
        modifier = modifier
            .clip(CircleShape)
            .background(bg)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text = symbol, color = fg, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
    }
}

// WorkspacePickerSheet lives in WorkspacePickerSheet.kt and is shared
// with IdeaDetailScreen.
