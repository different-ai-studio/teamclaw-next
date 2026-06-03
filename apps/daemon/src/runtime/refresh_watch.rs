use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio::time::MissedTickBehavior;
use tracing::warn;
use walkdir::WalkDir;

use super::{RefreshChangeKind, RefreshSource, RuntimeRefreshCoordinator};

const WATCH_POLL_INTERVAL: Duration = Duration::from_millis(350);
const WATCH_DEBOUNCE_WINDOW: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchedWorkspace {
    pub workspace_id: String,
    pub workspace_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassifiedChange {
    pub workspace_id: String,
    pub workspace_path: PathBuf,
    pub kind: RefreshChangeKind,
}

#[derive(Debug)]
pub struct RefreshDebounce {
    window: Duration,
    last_recorded_at: HashMap<(String, RefreshChangeKind), Instant>,
}

impl RefreshDebounce {
    pub fn new(window: Duration) -> Self {
        Self {
            window,
            last_recorded_at: HashMap::new(),
        }
    }

    pub fn recordable(
        &mut self,
        workspace_id: &str,
        kind: RefreshChangeKind,
        now: Instant,
    ) -> bool {
        let key = (workspace_id.to_string(), kind);
        if let Some(last_seen) = self.last_recorded_at.get(&key) {
            if now.duration_since(*last_seen) < self.window {
                return false;
            }
        }
        self.last_recorded_at.insert(key, now);
        true
    }
}

pub fn classify_change_path(
    path: &Path,
    workspaces: &[WatchedWorkspace],
    home: Option<&Path>,
) -> Vec<ClassifiedChange> {
    let mut changes = Vec::new();
    let mut seen = HashSet::new();

    let is_global_skill_path = home.is_some_and(|home_dir| {
        path.starts_with(home_dir.join(".config/teamclaw/skills"))
            || path.starts_with(home_dir.join(".config/opencode/skills"))
    });

    for workspace in workspaces {
        let kind = if path == workspace.workspace_path.join("opencode.json") {
            Some(RefreshChangeKind::OpencodeJson)
        } else if path.starts_with(workspace.workspace_path.join(".teamclaw/skills"))
            || path.starts_with(workspace.workspace_path.join(".opencode/skills"))
            || is_global_skill_path
        {
            Some(RefreshChangeKind::Skills)
        } else {
            None
        };

        let Some(kind) = kind else {
            continue;
        };

        if seen.insert((workspace.workspace_id.clone(), kind)) {
            changes.push(ClassifiedChange {
                workspace_id: workspace.workspace_id.clone(),
                workspace_path: workspace.workspace_path.clone(),
                kind,
            });
        }
    }

    changes
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PathStamp {
    is_dir: bool,
    len: u64,
    modified_secs: u64,
    modified_nanos: u32,
}

#[derive(Debug, Clone)]
struct WatchRoot {
    path: PathBuf,
    recursive: bool,
}

fn path_stamp(path: &Path) -> Option<PathStamp> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    let duration = modified
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0));
    Some(PathStamp {
        is_dir: metadata.is_dir(),
        len: metadata.len(),
        modified_secs: duration.as_secs(),
        modified_nanos: duration.subsec_nanos(),
    })
}

fn snapshot_root(root: &WatchRoot) -> HashMap<PathBuf, PathStamp> {
    let mut snapshot = HashMap::new();
    if root.recursive {
        if !root.path.exists() {
            return snapshot;
        }
        for entry in WalkDir::new(&root.path).into_iter().filter_map(Result::ok) {
            let path = entry.path().to_path_buf();
            if let Some(stamp) = path_stamp(&path) {
                snapshot.insert(path, stamp);
            }
        }
        return snapshot;
    }

    if let Some(stamp) = path_stamp(&root.path) {
        snapshot.insert(root.path.clone(), stamp);
    }
    snapshot
}

fn diff_paths(
    previous: &HashMap<PathBuf, PathStamp>,
    current: &HashMap<PathBuf, PathStamp>,
) -> Vec<PathBuf> {
    let mut changed = Vec::new();
    let mut keys: HashSet<&PathBuf> = previous.keys().collect();
    keys.extend(current.keys());

    for key in keys {
        if previous.get(key) != current.get(key) {
            changed.push(key.clone());
        }
    }

    changed
}

fn watch_roots(workspaces: &[WatchedWorkspace], home: Option<&Path>) -> Vec<WatchRoot> {
    let mut roots = Vec::new();
    for workspace in workspaces {
        roots.push(WatchRoot {
            path: workspace.workspace_path.join("opencode.json"),
            recursive: false,
        });
        roots.push(WatchRoot {
            path: workspace.workspace_path.join(".teamclaw/skills"),
            recursive: true,
        });
        roots.push(WatchRoot {
            path: workspace.workspace_path.join(".opencode/skills"),
            recursive: true,
        });
    }
    if let Some(home_dir) = home {
        roots.push(WatchRoot {
            path: home_dir.join(".config/teamclaw/skills"),
            recursive: true,
        });
        roots.push(WatchRoot {
            path: home_dir.join(".config/opencode/skills"),
            recursive: true,
        });
    }
    roots
}

pub fn start_refresh_watchers(
    refresh: std::sync::Arc<RuntimeRefreshCoordinator>,
    workspaces: Vec<WatchedWorkspace>,
    home: Option<PathBuf>,
) {
    if workspaces.is_empty() {
        return;
    }

    let roots = watch_roots(&workspaces, home.as_deref());
    if roots.is_empty() {
        return;
    }

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(WATCH_POLL_INTERVAL);
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

        let mut snapshots: HashMap<PathBuf, HashMap<PathBuf, PathStamp>> = roots
            .iter()
            .map(|root| (root.path.clone(), snapshot_root(root)))
            .collect();
        let mut debounce = RefreshDebounce::new(WATCH_DEBOUNCE_WINDOW);

        loop {
            interval.tick().await;

            let mut changed_paths = Vec::new();
            for root in &roots {
                let next = snapshot_root(root);
                let previous = snapshots.entry(root.path.clone()).or_default();
                changed_paths.extend(diff_paths(previous, &next));
                *previous = next;
            }

            changed_paths.sort();
            changed_paths.dedup();

            for path in changed_paths {
                for change in classify_change_path(&path, &workspaces, home.as_deref()) {
                    if !debounce.recordable(&change.workspace_id, change.kind, Instant::now()) {
                        continue;
                    }
                    if let Err(error) = refresh
                        .record_change(
                            &change.workspace_id,
                            &change.workspace_path,
                            change.kind,
                            RefreshSource::FilesystemWatch,
                        )
                        .await
                    {
                        warn!(
                            workspace_id = %change.workspace_id,
                            workspace_path = %change.workspace_path.display(),
                            changed_path = %path.display(),
                            error = %error,
                            "failed to record filesystem refresh change"
                        );
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn watched_workspace(id: &str, path: &str) -> WatchedWorkspace {
        WatchedWorkspace {
            workspace_id: id.to_string(),
            workspace_path: PathBuf::from(path),
        }
    }

    #[test]
    fn skill_path_change_maps_to_skills_kind() {
        let workspaces = vec![watched_workspace("ws-1", "/tmp/ws-1")];

        let changes = classify_change_path(
            Path::new("/tmp/ws-1/.teamclaw/skills/demo-skill/SKILL.md"),
            &workspaces,
            Some(Path::new("/Users/tester")),
        );

        assert_eq!(
            changes,
            vec![ClassifiedChange {
                workspace_id: "ws-1".to_string(),
                workspace_path: PathBuf::from("/tmp/ws-1"),
                kind: RefreshChangeKind::Skills,
            }]
        );
    }

    #[test]
    fn burst_events_are_debounced_into_one_recorded_change() {
        let mut debounce = RefreshDebounce::new(Duration::from_millis(250));
        let now = Instant::now();

        assert!(debounce.recordable("ws-1", RefreshChangeKind::Skills, now));
        assert!(!debounce.recordable(
            "ws-1",
            RefreshChangeKind::Skills,
            now + Duration::from_millis(50)
        ));
        assert!(debounce.recordable(
            "ws-1",
            RefreshChangeKind::Skills,
            now + Duration::from_millis(300)
        ));
    }
}
