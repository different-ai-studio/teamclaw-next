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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import tech.teamclaw.android.core.design.Hai
import tech.teamclaw.android.core.design.HaiHairline
import tech.teamclaw.android.core.design.HaiPaperCard
import tech.teamclaw.android.core.design.HaiSectionLabel
import tech.teamclaw.android.core.design.HaiSegment
import tech.teamclaw.android.core.design.HaiSegmentedFilterBar
import tech.teamclaw.android.core.design.HaiSheetRow
import tech.teamclaw.android.core.model.IdeaRecord
import tech.teamclaw.android.core.model.IdeaStatus
import tech.teamclaw.android.core.model.WorkspaceRecord

/**
 * Port of iOS `Collab/IdeaDetailView.swift` (the editable-detail half).
 * Inline edits: title, description, status, workspace, archive. Save
 * commits via [onSave]; the parent IdeaStore handles persistence.
 */
@Composable
fun IdeaDetailScreen(
    idea: IdeaRecord,
    workspaces: List<WorkspaceRecord>,
    isSaving: Boolean,
    errorMessage: String?,
    onBack: () -> Unit,
    onSave: (title: String, description: String, status: String, workspaceId: String) -> Unit,
    onArchiveToggle: (archived: Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    var title by remember(idea.id) { mutableStateOf(idea.title) }
    var description by remember(idea.id) { mutableStateOf(idea.description) }
    var status by remember(idea.id) { mutableStateOf(idea.status) }
    var workspaceId by remember(idea.id) { mutableStateOf(idea.workspaceId) }
    var showWorkspacePicker by remember { mutableStateOf(false) }

    val hasChanges = title.trim() != idea.title.trim() ||
        description.trim() != idea.description.trim() ||
        status != idea.status ||
        workspaceId != idea.workspaceId
    val canSave = title.isNotBlank() && hasChanges && !isSaving
    val selectedWorkspace = remember(workspaceId, workspaces) {
        workspaces.firstOrNull { it.id == workspaceId }
    }

    Column(modifier = modifier.fillMaxSize().background(Hai.Mist)) {
        DetailTopBar(
            onBack = onBack,
            onSave = {
                if (canSave) onSave(title.trim(), description.trim(), status, workspaceId)
            },
            canSave = canSave,
        )

        Spacer(Modifier.heightIn(min = 4.dp))
        HaiPaperCard {
            BasicTextField(
                value = title,
                onValueChange = { title = it },
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 14.dp, vertical = 14.dp)
                    .testTag("ideaDetail.titleField"),
                textStyle = TextStyle(
                    color = Hai.Onyx,
                    fontFamily = FontFamily.Serif,
                    fontWeight = FontWeight.Normal,
                    fontSize = 24.sp,
                ),
                cursorBrush = androidx.compose.ui.graphics.SolidColor(Hai.Cinnabar),
                decorationBox = { inner ->
                    if (title.isEmpty()) {
                        Text(
                            "Title",
                            color = Hai.Slate,
                            fontFamily = FontFamily.Serif,
                            fontSize = 24.sp,
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
                    .heightIn(min = 160.dp)
                    .padding(horizontal = 14.dp, vertical = 14.dp)
                    .testTag("ideaDetail.descriptionField"),
                textStyle = TextStyle(
                    color = Hai.Onyx,
                    fontFamily = FontFamily.SansSerif,
                    fontSize = 15.sp,
                ),
                cursorBrush = androidx.compose.ui.graphics.SolidColor(Hai.Cinnabar),
                decorationBox = { inner ->
                    if (description.isEmpty()) {
                        Text(
                            "Add detail, decisions, or links.",
                            color = Hai.Slate,
                            fontSize = 15.sp,
                        )
                    }
                    inner()
                },
            )
        }

        Spacer(Modifier.heightIn(min = 14.dp))
        HaiSectionLabel(title = "Status")
        Spacer(Modifier.heightIn(min = 6.dp))
        Box(modifier = Modifier.padding(horizontal = 16.dp)) {
            HaiSegmentedFilterBar(
                segments = listOf(
                    HaiSegment(IdeaStatus.OPEN, "Open"),
                    HaiSegment(IdeaStatus.IN_PROGRESS, "In Progress"),
                    HaiSegment(IdeaStatus.DONE, "Done"),
                ),
                selection = status,
                onSelect = { status = it },
                modifier = Modifier.fillMaxWidth(),
            )
        }

        Spacer(Modifier.heightIn(min = 14.dp))
        HaiSectionLabel(title = "Workspace")
        Spacer(Modifier.heightIn(min = 6.dp))
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

        Spacer(Modifier.heightIn(min = 14.dp))
        HaiSectionLabel(title = if (idea.archived) "Restore" else "Archive")
        Spacer(Modifier.heightIn(min = 6.dp))
        HaiPaperCard {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { onArchiveToggle(!idea.archived) }
                    .padding(horizontal = 14.dp, vertical = 14.dp)
                    .testTag("ideaDetail.archiveButton"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = if (idea.archived) "Restore idea" else "Archive idea",
                    color = if (idea.archived) Hai.Onyx else Hai.CinnabarDeep,
                    style = MaterialTheme.typography.labelLarge,
                    modifier = Modifier.weight(1f),
                )
                Text(text = "›", color = Hai.Slate, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
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

@Composable
private fun DetailTopBar(onBack: () -> Unit, onSave: () -> Unit, canSave: Boolean) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(onClick = onBack) { Text("Back", color = Hai.Cinnabar) }
        Spacer(modifier = Modifier.weight(1f))
        TextButton(
            onClick = onSave,
            enabled = canSave,
            modifier = Modifier.testTag("ideaDetail.saveButton"),
        ) {
            Text(
                text = "Save",
                color = if (canSave) Hai.Cinnabar else Hai.Slate,
                style = MaterialTheme.typography.labelLarge,
            )
        }
    }
}
