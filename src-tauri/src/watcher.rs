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

/// 마지막으로 프론트에 변경을 알린 시각 — emit 폭주 방지 throttle.
type LastEmit = Arc<Mutex<Instant>>;

#[derive(Clone, Default)]
struct FileState {
    offset: u64,
    buffer: String,
    parser: parser::ParseState,
}

#[derive(Clone)]
struct WatchState {
    files: Arc<Mutex<HashMap<PathBuf, FileState>>>,
    last_emit: LastEmit,
    processing: Arc<Mutex<()>>,
}

/// usage-updated emit 최소 간격 — 활발한 CLI 사용 시 초당 수십 modify 이벤트가 와도
/// 프론트 invalidate/sync 를 이 간격 이하로 제한한다.
const EMIT_THROTTLE: Duration = Duration::from_millis(1500);

pub struct FileWatcher {
    _watcher: RecommendedWatcher,
}

impl FileWatcher {
    pub fn start(app: AppHandle) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        // 첫 emit 이 startup 직후 곧바로 나가도록 throttle 기준을 과거로 둔다.
        let state = WatchState {
            files: Arc::new(Mutex::new(HashMap::new())),
            last_emit: Arc::new(Mutex::new(
                Instant::now()
                    .checked_sub(EMIT_THROTTLE)
                    .unwrap_or_else(Instant::now),
            )),
            processing: Arc::new(Mutex::new(())),
        };
        let state_c = state.clone();
        let app_c = app.clone();

        let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            let Ok(event) = res else { return };
            match event.kind {
                EventKind::Create(_) | EventKind::Modify(_) => {
                    for path in &event.paths {
                        if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                            process_file(path, &state_c, &app_c);
                        }
                    }
                }
                _ => {}
            }
        })?;

        let mut existing_dirs: Vec<PathBuf> = Vec::new();
        for dir in watch_dirs() {
            if dir.exists() {
                watcher.watch(&dir, RecursiveMode::Recursive)?;
                existing_dirs.push(dir);
            }
        }

        // 기존 파일 캐치업 파싱은 백그라운드 스레드로 — setup(메인 스레드)에서 동기로
        // 돌리면 백로그가 큰 재기동(헤비 유저 kill 후 등)에서 수 분간 창이 안 뜬다
        // (2026-07-22 기동 지연 사고). watch 등록을 먼저 끝냈으므로 스캔 중 유입되는
        // 이벤트도 놓치지 않고, process_file 은 processing mutex 로 전체 직렬화 +
        // offset 추적이라 스캔/이벤트 경합에도 중복 파싱이 없다.
        let state_bg = state.clone();
        let app_bg = app.clone();
        let spawned = std::thread::Builder::new()
            .name("catchup-parse".into())
            .spawn(move || {
                for dir in existing_dirs {
                    process_existing_files(&dir, &state_bg, &app_bg);
                }
            });
        if let Err(e) = spawned {
            eprintln!("[watcher] catchup thread spawn failed: {e}");
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

fn process_existing_files(dir: &Path, state: &WatchState, app: &AppHandle) {
    let Ok(entries) = walkdir_jsonl(dir) else {
        return;
    };
    for path in entries {
        process_file(&path, state, app);
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

fn process_file(path: &Path, state: &WatchState, app: &AppHandle) {
    let _processing = state.processing.lock().unwrap();
    let Ok(mut file) = fs::File::open(path) else {
        return;
    };
    let Ok(file_len) = file.metadata().map(|m| m.len()) else {
        return;
    };

    let mut file_state = {
        let map = state.files.lock().unwrap();
        map.get(path).cloned().unwrap_or_default()
    };

    file_state = reset_if_truncated(file_len, file_state);
    if file_len == file_state.offset {
        return; // no new bytes
    }

    if file.seek(SeekFrom::Start(file_state.offset)).is_err() {
        return;
    }
    let mut new_bytes = Vec::new();
    if file.read_to_end(&mut new_bytes).is_err() {
        return;
    }
    let new_text = String::from_utf8_lossy(&new_bytes).into_owned();

    // Prepend any leftover from previous read
    let full_text = file_state.buffer + &new_text;

    let source = detect_source(path);
    let project = extract_project(path);
    let session_id = extract_session_id(path);

    let (events, calls, leftover) = parser::parse_jsonl_chunk(
        parser::JsonlChunk {
            source: &source,
            text: &full_text,
            project: project.as_deref(),
            session_id: session_id.as_deref(),
        },
        &mut file_state.parser,
    );

    // Persist to SQLite
    if !events.is_empty() || !calls.is_empty() {
        let Ok(conn) = db::open() else {
            eprintln!("[watcher] database open failed; leaving file offset for retry");
            return;
        };
        if let Err(error) = persist(&conn, &events, &calls) {
            eprintln!("[watcher] usage persistence failed; leaving file offset for retry: {error}");
            return;
        }
    }

    // 새 사용량이 실제로 들어왔을 때만 프론트/트레이에 알림 (throttle 내장).
    if !events.is_empty() || !calls.is_empty() {
        notify_change(app, &state.last_emit);
    }

    // Update state
    file_state.offset += new_bytes.len() as u64;
    file_state.buffer = leftover;
    let mut files = state.files.lock().unwrap();
    files.insert(path.to_path_buf(), file_state);
}

fn reset_if_truncated(file_len: u64, file_state: FileState) -> FileState {
    if file_len < file_state.offset {
        // Truncate/recreate: the old byte offset and parser context no longer apply.
        FileState::default()
    } else {
        file_state
    }
}

fn persist(
    conn: &Connection,
    events: &[crate::models::UsageEvent],
    calls: &[crate::models::ToolCall],
) -> rusqlite::Result<()> {
    for e in events {
        db::insert_usage_event(conn, e)?;
    }
    for c in calls {
        db::insert_tool_call(conn, c)?;
    }
    Ok(())
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
    rel.components()
        .next()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
}

/// Uses the file stem as session_id
fn extract_session_id(path: &Path) -> Option<String> {
    path.file_stem().map(|s| s.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::{reset_if_truncated, FileState};

    #[test]
    fn truncated_file_resets_offset_and_parser_state() {
        let state = FileState {
            offset: 100,
            buffer: "partial".to_owned(),
            parser: crate::parser::ParseState::default(),
        };

        let reset = reset_if_truncated(10, state);

        assert_eq!(reset.offset, 0);
        assert!(reset.buffer.is_empty());
    }
}
