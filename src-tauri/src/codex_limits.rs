use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const TAIL_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RateLimitWindow {
    pub used_percent: f64,
    pub window_minutes: i64,
    pub resets_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexRateLimitSnapshot {
    pub limit_id: String,
    pub limit_name: Option<String>,
    pub plan_type: Option<String>,
    pub primary: Option<RateLimitWindow>,
    pub secondary: Option<RateLimitWindow>,
    pub observed_at: i64,
}

#[derive(Deserialize)]
struct RolloutEnvelope {
    timestamp: String,
    #[serde(rename = "type")]
    event_type: String,
    payload: RolloutPayload,
}

#[derive(Deserialize)]
struct RolloutPayload {
    #[serde(rename = "type")]
    payload_type: String,
    rate_limits: Option<RawSnapshot>,
}

#[derive(Deserialize)]
struct RawSnapshot {
    limit_id: String,
    limit_name: Option<String>,
    plan_type: Option<String>,
    primary: Option<RateLimitWindow>,
    secondary: Option<RateLimitWindow>,
}

/// 주간 창(10080분)보다 오래 수정되지 않은 rollout 의 한도는 이미 리셋이 지나 표시할 값이 없다.
/// 하루 여유를 둔 8일 이내 수정 파일만 읽는다 (2026-11 실측: 전체 1,373개 2.25GB tail 을 매번 읽어 8초).
const LIMIT_SCAN_LOOKBACK_MS: i64 = 8 * 24 * 60 * 60 * 1000;

/// 동기 command 는 메인 스레드에서 돌아 스캔 동안 팝오버가 멈추므로 blocking 풀에서 실행한다.
#[tauri::command]
pub async fn get_codex_rate_limits() -> Result<Vec<CodexRateLimitSnapshot>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let home = codex_home();
        let Some(account) = crate::codex_account::read_codex_account_from(home) else {
            return Vec::new();
        };
        let now_ms = chrono::Utc::now().timestamp_millis();
        read_current_codex_rate_limits_from(home, account.auth_started_at_ms, now_ms)
    })
    .await
    .map_err(|error| error.to_string())
}

#[cfg(test)]
fn read_codex_rate_limits(root: &Path) -> Vec<CodexRateLimitSnapshot> {
    read_codex_rate_limits_since(root, None, None)
}

fn read_codex_rate_limits_since(
    root: &Path,
    created_since_ms: Option<i64>,
    modified_since_ms: Option<i64>,
) -> Vec<CodexRateLimitSnapshot> {
    let mut files = Vec::new();
    collect_jsonl(root, &mut files);
    if let Some(cutoff) = created_since_ms {
        files.retain(|path| file_created_at_ms(path).is_some_and(|created| created >= cutoff));
    }
    if let Some(cutoff) = modified_since_ms {
        files.retain(|path| file_modified_at_ms(path).is_some_and(|modified| modified >= cutoff));
    }
    files.sort_by_key(|path| {
        (
            fs::metadata(path)
                .and_then(|metadata| metadata.modified())
                .ok(),
            path.clone(),
        )
    });

    let mut cache = FILE_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut snapshots = Vec::new();
    for path in files {
        let Some(key) = file_cache_key(&path) else {
            continue;
        };
        let fresh = match cache.get(&path) {
            Some((cached_key, cached)) if *cached_key == key => Some(cached.clone()),
            _ => None,
        };
        let file_snapshots = fresh.unwrap_or_else(|| {
            let read = read_file_snapshots(&path);
            cache.insert(path, (key, read.clone()));
            read
        });
        snapshots.extend(file_snapshots);
    }
    // 화면 조회(8일 창)와 업로드(직전 스캔 이후)가 범위를 달리해 같은 캐시를 쓰므로 호출마다
    // 갈아치우지 않고, 주간 창을 넘겨 다시 읽힐 일이 없는 파일만 버린다.
    let cache_floor = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_millis(
            (LIMIT_SCAN_LOOKBACK_MS + 24 * 60 * 60 * 1000) as u64,
        ))
        .unwrap_or(std::time::UNIX_EPOCH);
    cache.retain(|_, ((modified, _), _)| *modified >= cache_floor);
    select_latest_snapshots(snapshots)
}

/// (수정 시각, 크기) 가 같으면 rollout 은 append-only 라 내용도 같다고 본다.
type FileCacheKey = (std::time::SystemTime, u64);

/// 30초마다 반복되는 한도 조회가 바뀌지 않은 rollout 을 다시 읽지 않도록 파일별 결과를 보관한다.
/// 크기는 최근 9일 안에 수정된 rollout 수로 제한된다.
static FILE_CACHE: Mutex<BTreeMap<PathBuf, (FileCacheKey, Vec<CodexRateLimitSnapshot>)>> =
    Mutex::new(BTreeMap::new());

fn file_cache_key(path: &Path) -> Option<FileCacheKey> {
    let metadata = fs::metadata(path).ok()?;
    Some((metadata.modified().ok()?, metadata.len()))
}

fn read_file_snapshots(path: &Path) -> Vec<CodexRateLimitSnapshot> {
    read_tail(path)
        .map(|text| {
            text.lines()
                .filter(|line| line.contains("\"rate_limits\""))
                .filter_map(parse_snapshot)
                .collect()
        })
        .unwrap_or_default()
}

fn file_created_at_ms(path: &Path) -> Option<i64> {
    fs::metadata(path)
        .and_then(|metadata| metadata.created())
        .ok()
        .and_then(|created| created.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
}

fn file_modified_at_ms(path: &Path) -> Option<i64> {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
}

pub(crate) use crate::codex_home::codex_home;

fn read_current_codex_rate_limits_from(
    home: &Path,
    auth_started_at_ms: i64,
    now_ms: i64,
) -> Vec<CodexRateLimitSnapshot> {
    let modified_since = auth_started_at_ms.max(now_ms.saturating_sub(LIMIT_SCAN_LOOKBACK_MS));
    read_account_codex_rate_limits_from(home, auth_started_at_ms, modified_since)
}

pub(crate) fn read_account_codex_rate_limits_from(
    home: &Path,
    created_since_ms: i64,
    modified_since_ms: i64,
) -> Vec<CodexRateLimitSnapshot> {
    let root = home.join("sessions");
    if root.exists() {
        read_codex_rate_limits_since(&root, Some(created_since_ms), Some(modified_since_ms))
    } else {
        Vec::new()
    }
}

fn collect_jsonl(dir: &Path, output: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_jsonl(&path, output);
        } else if file_type.is_file()
            && path.extension().and_then(|extension| extension.to_str()) == Some("jsonl")
        {
            output.push(path);
        }
    }
}

fn read_tail(path: &Path) -> std::io::Result<String> {
    if !fs::symlink_metadata(path)?.file_type().is_file() {
        return Err(std::io::Error::other(
            "rate-limit source is not a regular file",
        ));
    }
    let mut file = fs::File::open(path)?;
    let length = file.metadata()?.len();
    let start = length.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(TAIL_BYTES).read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes);
    if start == 0 {
        return Ok(text.into_owned());
    }
    Ok(text
        .split_once('\n')
        .map_or_else(String::new, |(_, rest)| rest.to_owned()))
}

fn parse_snapshot(line: &str) -> Option<CodexRateLimitSnapshot> {
    let envelope = serde_json::from_str::<RolloutEnvelope>(line).ok()?;
    if envelope.event_type != "event_msg" || envelope.payload.payload_type != "token_count" {
        return None;
    }
    let raw = envelope.payload.rate_limits?;
    if raw.limit_id.is_empty()
        || !raw.primary.as_ref().is_none_or(valid_window)
        || !raw.secondary.as_ref().is_none_or(valid_window)
    {
        return None;
    }
    let observed_at = chrono::DateTime::parse_from_rfc3339(&envelope.timestamp)
        .ok()?
        .timestamp_millis();
    Some(CodexRateLimitSnapshot {
        limit_id: raw.limit_id,
        limit_name: raw.limit_name,
        plan_type: raw.plan_type,
        primary: raw.primary,
        secondary: raw.secondary,
        observed_at,
    })
}

fn valid_window(window: &RateLimitWindow) -> bool {
    window.used_percent.is_finite()
        && (0.0..=100.0).contains(&window.used_percent)
        && window.window_minutes > 0
        && window.resets_at > 0
}

fn select_latest_snapshots(
    snapshots: impl IntoIterator<Item = CodexRateLimitSnapshot>,
) -> Vec<CodexRateLimitSnapshot> {
    let mut latest = BTreeMap::<String, CodexRateLimitSnapshot>::new();
    for snapshot in snapshots {
        let replace = latest
            .get(&snapshot.limit_id)
            .is_none_or(|current| snapshot.observed_at >= current.observed_at);
        if replace {
            latest.insert(snapshot.limit_id.clone(), snapshot);
        }
    }
    latest.into_values().collect()
}

#[cfg(test)]
#[path = "codex_limits_tests.rs"]
mod tests;
