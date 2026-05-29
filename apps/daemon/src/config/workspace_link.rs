//! Creates and repairs the `teamclaw-team` entry inside a workspace so it
//! points at the team's single global copy (see [`super::global_team_store`]).
//!
//! Unix/macOS use a symlink. Windows tries a directory junction, then falls
//! back to "no link, read the global dir directly" so opening a workspace
//! never fails on symlink-privilege errors.

use std::path::Path;

use super::global_team_store::{self, TEAM_LINK_NAME};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkKind {
    Symlink,
    Junction,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkStatus {
    /// `teamclaw-team` is a working link to the global dir.
    Linked(LinkKind),
    /// Could not create a link; readers must use the global dir directly.
    Fallback,
    /// A legacy real dir with un-synced changes was left untouched.
    LegacyDirRetained { reason: String },
}

/// Ensure `<workspace_root>/teamclaw-team` points at the global team dir for
/// `team_id`. Idempotent. Never errors — returns the resulting status.
pub fn ensure_workspace_link(workspace_root: &Path, team_id: &str) -> LinkStatus {
    let target = match global_team_store::ensure_initialized(team_id) {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(team_id, "global team dir init failed: {e}");
            return LinkStatus::Fallback;
        }
    };
    let link = workspace_root.join(TEAM_LINK_NAME);

    // Already a symlink: repoint if stale, else done.
    if let Ok(meta) = std::fs::symlink_metadata(&link) {
        if meta.file_type().is_symlink() {
            match std::fs::read_link(&link) {
                Ok(dest) if dest == target => return LinkStatus::Linked(LinkKind::Symlink),
                _ => {
                    let _ = std::fs::remove_file(&link);
                }
            }
        } else if meta.is_dir() {
            // Legacy real dir → migration (Task 4 fills this in).
            return migrate_legacy_dir(&link, &target);
        }
    }

    create_link(&link, &target)
}

/// Platform link creation with fallback chain.
fn create_link(link: &Path, target: &Path) -> LinkStatus {
    #[cfg(unix)]
    {
        match std::os::unix::fs::symlink(target, link) {
            Ok(()) => LinkStatus::Linked(LinkKind::Symlink),
            Err(e) => {
                tracing::warn!(
                    "symlink {} -> {} failed: {e}",
                    link.display(),
                    target.display()
                );
                LinkStatus::Fallback
            }
        }
    }
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_dir(target, link).is_ok() {
            return LinkStatus::Linked(LinkKind::Symlink);
        }
        if junction_create(link, target).is_ok() {
            return LinkStatus::Linked(LinkKind::Junction);
        }
        tracing::warn!(
            "symlink/junction {} failed; falling back to direct global read",
            link.display()
        );
        LinkStatus::Fallback
    }
}

#[cfg(windows)]
fn junction_create(link: &Path, target: &Path) -> std::io::Result<()> {
    // `mklink /J` creates a junction without admin rights.
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            "mklink /J failed",
        ))
    }
}

/// Migration placeholder — replaced in Task 4.
fn migrate_legacy_dir(_link: &Path, _target: &Path) -> LinkStatus {
    LinkStatus::LegacyDirRetained {
        reason: "migration not yet implemented".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sets an isolated `HOME` and holds the shared HOME lock for the test's
    /// duration so path assertions don't race other HOME-mutating tests.
    fn temp_home() -> (
        tempfile::TempDir,
        std::sync::MutexGuard<'static, ()>,
    ) {
        let guard = global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        (tmp, guard)
    }

    #[cfg(unix)]
    #[test]
    fn creates_symlink_to_global_dir() {
        let (_home, _guard) = temp_home();
        let ws = tempfile::tempdir().unwrap();
        let status = ensure_workspace_link(ws.path(), "team-1");
        assert_eq!(status, LinkStatus::Linked(LinkKind::Symlink));
        let link = ws.path().join("teamclaw-team");
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::read_link(&link).unwrap(),
            global_team_store::global_team_dir("team-1")
        );
    }

    #[cfg(unix)]
    #[test]
    fn is_idempotent() {
        let (_home, _guard) = temp_home();
        let ws = tempfile::tempdir().unwrap();
        assert_eq!(
            ensure_workspace_link(ws.path(), "team-1"),
            LinkStatus::Linked(LinkKind::Symlink)
        );
        // Second call: still linked, no error.
        assert_eq!(
            ensure_workspace_link(ws.path(), "team-1"),
            LinkStatus::Linked(LinkKind::Symlink)
        );
    }

    #[cfg(unix)]
    #[test]
    fn repoints_stale_symlink() {
        let (_home, _guard) = temp_home();
        let ws = tempfile::tempdir().unwrap();
        let link = ws.path().join("teamclaw-team");
        std::os::unix::fs::symlink("/nonexistent/old", &link).unwrap();
        assert_eq!(
            ensure_workspace_link(ws.path(), "team-1"),
            LinkStatus::Linked(LinkKind::Symlink)
        );
        assert_eq!(
            std::fs::read_link(&link).unwrap(),
            global_team_store::global_team_dir("team-1")
        );
    }
}
