use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::Connection;
use std::collections::{HashMap, HashSet};
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

/// 안전망 주기 재스캔 간격 — 장기 무재시작 실행에서 라이브 notify 가 놓친 파일과
/// 기동 뒤 생긴 계정 홈(orca 등)을 이 주기로 흡수한다. sleep-first 라 첫 재스캔은
/// T+RESCAN_INTERVAL (startup catch-up 과 중복 스캔 없음).
const RESCAN_INTERVAL: Duration = Duration::from_secs(300);

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

        // 주기 안전망 재스캔 — startup 고정 트리거(watch 등록·catch-up 1회·codex_home
        // OnceLock)가 장기 무재시작 실행에서 드리프트하는 것을 덮는다. 매 주기 계정 홈을
        // fresh 재해석해 기동 뒤 생긴 홈(orca 등)까지 흡수하고, WatchState(offset 맵)를
        // 라이브 watcher 와 공유하므로 이미 파싱한 파일은 file_len==offset 조기반환(재파싱 0).
        // 이 스레드가 조용히 죽으면 orca 는 유일 수집 경로를 잃으므로(동적 re-watch 없음)
        // 사이클을 catch_unwind 로 감싸 한 사이클 패닉에 루프를 지킨다.
        let state_rescan = state.clone();
        let app_rescan = app.clone();
        let spawned_rescan = std::thread::Builder::new()
            .name("rescan-parse".into())
            .spawn(move || {
                let mut seen_dirs: HashSet<PathBuf> = HashSet::new();
                loop {
                    std::thread::sleep(RESCAN_INTERVAL);
                    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        rescan_once(&state_rescan, &app_rescan, &mut seen_dirs);
                    }));
                    if outcome.is_err() {
                        eprintln!("[watcher] rescan cycle panicked; loop continues");
                    }
                }
            });
        if let Err(e) = spawned_rescan {
            eprintln!("[watcher] rescan thread spawn failed: {e}");
        }

        Ok(FileWatcher { _watcher: watcher })
    }
}

/// SQLite 에 새 사용량이 들어왔음을 프론트(usage-updated 이벤트)와 트레이에 알린다.
/// EMIT_THROTTLE 이내 중복 호출은 무시해 invalidate/sync 폭주를 막는다.
fn notify_change(app: &AppHandle, last_emit: &LastEmit) {
    {
        // poison-tolerant — 어느 한 스레드의 패닉이 라이브 watcher/재스캔을 cascade 로
        // 죽이지 않도록 into_inner 로 복구한다(가드 데이터는 Instant/오프셋 맵이라 안전).
        let mut last = last_emit.lock().unwrap_or_else(|e| e.into_inner());
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
    watch_dirs_for(&home, crate::codex_limits::codex_home())
}

fn watch_dirs_for(home: &Path, codex_home: &Path) -> Vec<PathBuf> {
    let default_codex_sessions = home.join(".codex").join("sessions");
    let account_codex_sessions = codex_home.join("sessions");
    let mut dirs = vec![
        home.join(".claude").join("projects"),
        default_codex_sessions.clone(),
        home.join(".pi").join("agent").join("sessions"),
    ];
    if account_codex_sessions != default_codex_sessions {
        dirs.push(account_codex_sessions);
    }

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

/// 안전망 재스캔 1회 — 계정 홈을 fresh 재해석(`resolve_current_codex_home`)해 현재
/// watch 대상을 다시 걸고 신규/증분 파일을 파싱한다. `codex_home()` OnceLock 은 계정
/// 한도 전용이라 여기서 건드리지 않는다. 처음 보는 홈은 진단용으로 1회만 로그한다
/// (`seen_dirs` 는 rescan 스레드-로컬 누적).
fn rescan_once(state: &WatchState, app: &AppHandle, seen_dirs: &mut HashSet<PathBuf>) {
    let home = home_dir();
    let codex_home = crate::codex_home::resolve_current_codex_home();
    for dir in watch_dirs_for(&home, &codex_home) {
        if !dir.exists() {
            continue;
        }
        if seen_dirs.insert(dir.clone()) {
            eprintln!("[watcher] rescan tracking dir: {}", dir.display());
        }
        process_existing_files(&dir, state, app);
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
    // poison-tolerant 락 — 아래 참여 스레드(라이브 notify·catch-up·재스캔) 중 하나가
    // 패닉해 뮤텍스가 poison 되어도 나머지가 계속 수집하도록 into_inner 로 복구한다.
    let _processing = state.processing.lock().unwrap_or_else(|e| e.into_inner());
    let Ok(mut file) = fs::File::open(path) else {
        return;
    };
    let Ok(file_len) = file.metadata().map(|m| m.len()) else {
        return;
    };

    let mut file_state = {
        let map = state.files.lock().unwrap_or_else(|e| e.into_inner());
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
    let mut files = state.files.lock().unwrap_or_else(|e| e.into_inner());
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
    persist_since(conn, events, calls, crate::retention::cutoff_ms())
}

/// 보존 컷오프 이전 이벤트는 아예 저장하지 않는다.
/// 파일 offset 이 메모리 전용이라 재기동마다 JSONL 을 전량 재파싱하는데, 이 필터가 없으면
/// retention 이 지운 옛 데이터가 매 기동마다 되살아나고 Supabase 재업로드까지 유발한다.
fn persist_since(
    conn: &Connection,
    events: &[crate::models::UsageEvent],
    calls: &[crate::models::ToolCall],
    cutoff_ms: i64,
) -> rusqlite::Result<()> {
    for e in events {
        if e.ts < cutoff_ms {
            continue;
        }
        db::insert_usage_event(conn, e)?;
    }
    for c in calls {
        if c.ts < cutoff_ms {
            continue;
        }
        db::insert_tool_call(conn, c)?;
    }
    Ok(())
}

fn detect_source(path: &Path) -> String {
    detect_source_for(path, &crate::codex_limits::codex_home().join("sessions"))
}

fn detect_source_for(path: &Path, codex_sessions: &Path) -> String {
    let s = path.to_string_lossy();
    if path.starts_with(codex_sessions) {
        "codex".to_owned()
    } else if s.contains(".pi/agent/sessions") || s.contains(".pi\\agent\\sessions") {
        "pi".to_owned()
    } else if s.contains(".claude") {
        "claude".to_owned()
    } else if s.contains(".codex") || s.contains("codex-runtime-home") {
        // `codex-runtime-home` = orca 관리 Codex 런타임 홈. 이 리터럴은
        // codex_home.rs 의 `orca/codex-runtime-home/home` 경로와 동기 유지할 것.
        // orca 경로는 `.codex` 문자열을 안 포함하므로, OnceLock 이 기본 홈을
        // 가리킬 때(orca 홈이 기동 후 생성된 경우) starts_with 브랜치를 못 타
        // "unknown" 으로 드롭된다 — 여기서 codex 로 잡아 재스캔 수집을 보장한다.
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
mod tests;
