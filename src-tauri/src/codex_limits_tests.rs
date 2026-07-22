use super::{
    parse_snapshot, read_codex_rate_limits, read_current_codex_rate_limits_from,
    select_latest_snapshots,
};
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
    let root = std::env::temp_dir().join(format!("codex-limits-{}-{nonce}", std::process::id()));
    fs::create_dir_all(&root).expect("create fixture directory");

    let rare = STANDARD.replace("\"codex\"", "\"rare-model\"");
    fs::write(root.join("000.jsonl"), rare).expect("write rare limit");
    for index in 1..=512 {
        let percent = if index == 512 { "60.0" } else { "59.0" };
        let snapshot = STANDARD.replace("100.0", percent);
        fs::write(root.join(format!("{index:03}.jsonl")), snapshot).expect("write standard limit");
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

#[test]
fn test_account_scan_excludes_files_created_before_auth_boundary() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    let home =
        std::env::temp_dir().join(format!("codex-account-scan-{}-{nonce}", std::process::id()));
    let sessions = home.join("sessions");
    fs::create_dir_all(&sessions).expect("create fixture directory");
    fs::write(sessions.join("session.jsonl"), STANDARD).expect("write session");
    let now_ms = i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_millis(),
    )
    .expect("timestamp fits i64");

    let included = read_current_codex_rate_limits_from(&home, now_ms - 1_000);
    let excluded = read_current_codex_rate_limits_from(&home, now_ms + 1_000);
    fs::remove_dir_all(&home).expect("remove fixture directory");

    assert_eq!(included.len(), 1);
    assert!(excluded.is_empty());
}
