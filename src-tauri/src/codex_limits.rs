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
    let root = codex_home().join("sessions");
    if !root.exists() {
        return Ok(Vec::new());
    }
    Ok(read_codex_rate_limits(&root))
}

fn read_codex_rate_limits(root: &Path) -> Vec<CodexRateLimitSnapshot> {
    let mut files = Vec::new();
    collect_jsonl(root, &mut files);
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

fn codex_home() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
        .unwrap_or_else(|| PathBuf::from(".codex"))
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
mod tests {
    use super::{parse_snapshot, read_codex_rate_limits, select_latest_snapshots};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    const STANDARD: &str = r#"{"timestamp":"2026-07-12T23:30:15.214Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex","limit_name":null,"primary":{"used_percent":100.0,"window_minutes":300,"resets_at":1783865360},"secondary":{"used_percent":21.0,"window_minutes":10080,"resets_at":1784452160},"plan_type":"pro"}}}"#;
    const SPARK: &str = r#"{"timestamp":"2026-07-13T00:46:47.346Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex_bengalfox","limit_name":"GPT-5.3-Codex-Spark","primary":{"used_percent":4.0,"window_minutes":10080,"resets_at":1784504577},"secondary":null,"plan_type":"pro"}}}"#;

    #[test]
    fn test_parse_snapshot_reads_standard_and_model_limits() {
        let standard = parse_snapshot(STANDARD).expect("standard snapshot");
        let spark = parse_snapshot(SPARK).expect("model snapshot");

        assert_eq!(standard.limit_id, "codex");
        assert_eq!(
            standard.primary.as_ref().map(|window| window.used_percent),
            Some(100.0)
        );
        assert_eq!(
            standard
                .secondary
                .as_ref()
                .map(|window| window.used_percent),
            Some(21.0)
        );
        assert_eq!(spark.limit_name.as_deref(), Some("GPT-5.3-Codex-Spark"));
        assert_eq!(spark.secondary, None);
    }

    #[test]
    fn test_select_latest_snapshots_keeps_newest_per_limit_id() {
        let older = STANDARD.replace("2026-07-12T23:30:15.214Z", "2026-07-11T23:30:15.214Z");
        let older = older.replace("100.0", "80.0");
        let snapshots = [
            parse_snapshot(&older).expect("older snapshot"),
            parse_snapshot(STANDARD).expect("newer snapshot"),
            parse_snapshot(SPARK).expect("model snapshot"),
        ];

        let selected = select_latest_snapshots(snapshots);

        assert_eq!(selected.len(), 2);
        assert_eq!(selected[0].limit_id, "codex");
        assert_eq!(
            selected[0]
                .primary
                .as_ref()
                .map(|window| window.used_percent),
            Some(100.0)
        );
    }

    #[test]
    fn test_select_latest_snapshots_prefers_later_equal_timestamp_record() {
        let corrected = STANDARD.replace("100.0", "75.0");
        let selected = select_latest_snapshots([
            parse_snapshot(STANDARD).expect("initial snapshot"),
            parse_snapshot(&corrected).expect("corrected snapshot"),
        ]);

        assert_eq!(
            selected[0]
                .primary
                .as_ref()
                .map(|window| window.used_percent),
            Some(75.0)
        );
    }

    #[test]
    fn test_file_scan_keeps_rare_limit_beyond_512_files_and_later_equal_timestamp() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("codex-limits-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&root).expect("create fixture directory");

        let rare = STANDARD.replace("\"codex\"", "\"rare-model\"");
        fs::write(root.join("000.jsonl"), rare).expect("write rare limit");
        for index in 1..=512 {
            let percent = if index == 512 { "60.0" } else { "59.0" };
            let snapshot = STANDARD.replace("100.0", percent);
            fs::write(root.join(format!("{index:03}.jsonl")), snapshot)
                .expect("write standard limit");
        }

        let selected = read_codex_rate_limits(&root);
        fs::remove_dir_all(&root).expect("remove fixture directory");

        assert!(selected
            .iter()
            .any(|snapshot| snapshot.limit_id == "rare-model"));
        let standard = selected
            .iter()
            .find(|snapshot| snapshot.limit_id == "codex")
            .expect("standard limit");
        assert_eq!(
            standard.primary.as_ref().map(|window| window.used_percent),
            Some(60.0)
        );
    }

    #[test]
    fn test_parse_snapshot_rejects_invalid_percent() {
        let invalid = STANDARD.replace("100.0", "101.0");

        assert!(parse_snapshot(&invalid).is_none());
    }
}
