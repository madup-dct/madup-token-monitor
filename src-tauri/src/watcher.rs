use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::Connection;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::db;
use crate::parser;

/// Per-file state: how many bytes we have already consumed.
type FileOffsets = Arc<Mutex<HashMap<PathBuf, u64>>>;
/// Per-file partial-line buffer.
type FileBuffers = Arc<Mutex<HashMap<PathBuf, String>>>;
/// 마지막으로 프론트에 변경을 알린 시각 — emit 폭주 방지 throttle.
type LastEmit = Arc<Mutex<Instant>>;

/// usage-updated emit 최소 간격 — 활발한 CLI 사용 시 초당 수십 modify 이벤트가 와도
/// 프론트 invalidate/sync 를 이 간격 이하로 제한한다.
const EMIT_THROTTLE: Duration = Duration::from_millis(1500);

pub struct FileWatcher {
    _watcher: RecommendedWatcher,
}

impl FileWatcher {
    pub fn start(app: AppHandle) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let offsets: FileOffsets = Arc::new(Mutex::new(HashMap::new()));
        let buffers: FileBuffers = Arc::new(Mutex::new(HashMap::new()));
        // 첫 emit 이 startup 직후 곧바로 나가도록 throttle 기준을 과거로 둔다.
        let last_emit: LastEmit = Arc::new(Mutex::new(
            Instant::now()
                .checked_sub(EMIT_THROTTLE)
                .unwrap_or_else(Instant::now),
        ));

        let offsets_c = Arc::clone(&offsets);
        let buffers_c = Arc::clone(&buffers);
        let last_emit_c = Arc::clone(&last_emit);
        let app_c = app.clone();

        let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            let Ok(event) = res else { return };
            match event.kind {
                EventKind::Create(_) | EventKind::Modify(_) => {
                    for path in &event.paths {
                        if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                            process_file(path, &offsets_c, &buffers_c, &app_c, &last_emit_c);
                        }
                    }
                }
                _ => {}
            }
        })?;

        for dir in watch_dirs() {
            if dir.exists() {
                watcher.watch(&dir, RecursiveMode::Recursive)?;
                // Process existing files on startup
                process_existing_files(&dir, &offsets, &buffers, &app, &last_emit);
            }
        }

        Ok(FileWatcher { _watcher: watcher })
    }
}

/// SQLite 에 새 사용량이 들어왔음을 프론트(usage-updated 이벤트)와 트레이에 알린다.
/// EMIT_THROTTLE 이내 중복 호출은 무시해 invalidate/sync 폭주를 막는다.
fn notify_change(app: &AppHandle, last_emit: &LastEmit) {
    {
        let mut last = last_emit.lock().unwrap();
        if last.elapsed() < EMIT_THROTTLE {
            return;
        }
        *last = Instant::now();
    }
    let _ = app.emit("usage-updated", ());
    // 트레이 '오늘 비용' 텍스트도 즉시 갱신 (60s 폴링 기다리지 않음).
    crate::tray::refresh_tray_title(app);
}

fn watch_dirs() -> Vec<PathBuf> {
    let home = home_dir();
    let mut dirs = vec![
        home.join(".claude").join("projects"),
        home.join(".codex").join("sessions"),
    ];

    // OpenCode: macOS uses ~/.local/share, Windows uses %LOCALAPPDATA%
    #[cfg(target_os = "windows")]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            dirs.push(PathBuf::from(local).join("opencode"));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        dirs.push(home.join(".local").join("share").join("opencode"));
    }

    dirs
}

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn process_existing_files(
    dir: &Path,
    offsets: &FileOffsets,
    buffers: &FileBuffers,
    app: &AppHandle,
    last_emit: &LastEmit,
) {
    let Ok(entries) = walkdir_jsonl(dir) else { return };
    for path in entries {
        process_file(&path, offsets, buffers, app, last_emit);
    }
}

fn walkdir_jsonl(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut results = Vec::new();
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for entry in rd.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                out.push(path);
            }
        }
    }
    walk(dir, &mut results);
    Ok(results)
}

fn process_file(
    path: &Path,
    offsets: &FileOffsets,
    buffers: &FileBuffers,
    app: &AppHandle,
    last_emit: &LastEmit,
) {
    let Ok(mut file) = fs::File::open(path) else { return };
    let file_len = file.metadata().map(|m| m.len()).unwrap_or(0);

    let offset = {
        let mut map = offsets.lock().unwrap();
        *map.entry(path.to_path_buf()).or_insert(0)
    };

    if file_len <= offset {
        return; // no new bytes
    }

    file.seek(SeekFrom::Start(offset)).ok();
    let mut new_bytes = Vec::new();
    file.read_to_end(&mut new_bytes).ok();
    let new_text = String::from_utf8_lossy(&new_bytes).into_owned();

    // Prepend any leftover from previous read
    let prev_buf = {
        let mut map = buffers.lock().unwrap();
        map.remove(path).unwrap_or_default()
    };
    let full_text = prev_buf + &new_text;

    let source = detect_source(path);
    let project = extract_project(path);
    let session_id = extract_session_id(path);

    let (events, calls, leftover) =
        parser::parse_jsonl(&source, &full_text, project.as_deref(), session_id.as_deref());

    // Persist to SQLite
    if let Ok(conn) = db::open() {
        persist(&conn, &events, &calls);
    }

    // 새 사용량이 실제로 들어왔을 때만 프론트/트레이에 알림 (throttle 내장).
    if !events.is_empty() || !calls.is_empty() {
        notify_change(app, last_emit);
    }

    // Update state
    {
        let mut map = offsets.lock().unwrap();
        map.insert(path.to_path_buf(), offset + new_bytes.len() as u64);
    }
    {
        let mut map = buffers.lock().unwrap();
        if !leftover.is_empty() {
            map.insert(path.to_path_buf(), leftover);
        }
    }
}

fn persist(
    conn: &Connection,
    events: &[crate::models::UsageEvent],
    calls: &[crate::models::ToolCall],
) {
    for e in events {
        db::insert_usage_event(conn, e).ok();
    }
    for c in calls {
        db::insert_tool_call(conn, c).ok();
    }
}

fn detect_source(path: &Path) -> String {
    let s = path.to_string_lossy();
    if s.contains(".claude") {
        "claude".to_owned()
    } else if s.contains(".codex") {
        "codex".to_owned()
    } else if s.contains("opencode") {
        "opencode".to_owned()
    } else {
        "unknown".to_owned()
    }
}

/// Extracts project name from path (Claude Code: ~/.claude/projects/<project>/<session>.jsonl)
fn extract_project(path: &Path) -> Option<String> {
    let home = home_dir();
    let base = home.join(".claude").join("projects");
    let rel = path.strip_prefix(&base).ok()?;
    rel.components().next().map(|c| c.as_os_str().to_string_lossy().into_owned())
}

/// Uses the file stem as session_id
fn extract_session_id(path: &Path) -> Option<String> {
    path.file_stem().map(|s| s.to_string_lossy().into_owned())
}
