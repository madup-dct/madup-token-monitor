use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

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

#[tauri::command]
pub fn get_codex_rate_limits() -> Result<Vec<CodexRateLimitSnapshot>, String> {
    let home = codex_home();
    let Some(account) = crate::codex_account::read_codex_account_from(home) else {
        return Ok(Vec::new());
    };
    Ok(read_current_codex_rate_limits_from(
        home,
        account.auth_started_at_ms,
    ))
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

    let snapshots = files
        .iter()
        .filter_map(|path| read_tail(path).ok())
        .flat_map(|text| {
            text.lines()
                .filter(|line| line.contains("\"rate_limits\""))
                .filter_map(parse_snapshot)
                .collect::<Vec<_>>()
        });
    select_latest_snapshots(snapshots)
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
) -> Vec<CodexRateLimitSnapshot> {
    read_account_codex_rate_limits_from(home, auth_started_at_ms, auth_started_at_ms)
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
