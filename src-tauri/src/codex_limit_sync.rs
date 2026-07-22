use chrono::Utc;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

static LAST_SCAN: Mutex<Option<Instant>> = Mutex::new(None);
static LAST_UPLOAD: Mutex<Option<(String, String)>> = Mutex::new(None);
static COOLDOWN_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);
static SNAPSHOT_CACHE: Mutex<Option<SnapshotCache>> = Mutex::new(None);

const SCAN_INTERVAL: Duration = Duration::from_secs(60);
const FAILURE_COOLDOWN: Duration = Duration::from_secs(300);
const MAX_OBSERVATION_AGE_MINUTES: i64 = 30;

struct SnapshotCache {
    account_id: String,
    last_scan_ms: i64,
    snapshots: HashMap<String, crate::codex_limits::CodexRateLimitSnapshot>,
}

pub fn upload_if_fresh() {
    if is_waiting(&COOLDOWN_UNTIL) || is_waiting(&LAST_SCAN) {
        return;
    }
    set_deadline(&LAST_SCAN, SCAN_INTERVAL);

    let codex_home = crate::codex_home::codex_home();
    let Some(account) = crate::codex_account::read_codex_account_from(codex_home) else {
        return;
    };
    let scan_started_at = Utc::now().timestamp_millis();
    let modified_since = SNAPSHOT_CACHE
        .lock()
        .ok()
        .and_then(|cache| {
            cache
                .as_ref()
                .filter(|cache| cache.account_id == account.account_id)
                .map(|cache| cache.last_scan_ms.saturating_sub(1_000))
        })
        .unwrap_or(account.auth_started_at_ms);
    let updates = crate::codex_limits::read_account_codex_rate_limits_from(
        codex_home,
        account.auth_started_at_ms,
        modified_since,
    );
    let snapshots = merge_snapshot_cache(&account, updates, scan_started_at);
    let Some(upload) = crate::codex_account::build_codex_limit_upload(&account, &snapshots) else {
        return;
    };
    let Ok(fetched_at) = chrono::DateTime::parse_from_rfc3339(&upload.fetched_at) else {
        return;
    };
    let observation_age = Utc::now().signed_duration_since(fetched_at).num_minutes();
    if !(-5..=MAX_OBSERVATION_AGE_MINUTES).contains(&observation_age) {
        return;
    }
    if crate::codex_account::read_codex_account_from(codex_home).as_ref() != Some(&account) {
        return;
    }
    let upload_key = (upload.account_id.clone(), upload.fetched_at.clone());
    if LAST_UPLOAD
        .lock()
        .ok()
        .is_some_and(|value| value.as_ref() == Some(&upload_key))
    {
        return;
    }

    let body = serde_json::json!({
        "p_account_id": upload.account_id,
        "p_account_email": upload.account_email,
        "p_plan_type": upload.plan_type,
        "p_windows": upload.windows,
        "p_fetched_at": upload.fetched_at,
    });
    match crate::aggregator::post_supabase_rpc("upsert_codex_limit_snapshot", body) {
        None => {}
        Some(Ok(())) => {
            if let Ok(mut last_upload) = LAST_UPLOAD.lock() {
                *last_upload = Some(upload_key);
            }
            if let Ok(mut cooldown) = COOLDOWN_UNTIL.lock() {
                *cooldown = None;
            }
        }
        Some(Err(error)) => {
            eprintln!("[codex-limit-snapshot] upload failed: {error}");
            set_deadline(&COOLDOWN_UNTIL, FAILURE_COOLDOWN);
        }
    }
}

fn merge_snapshot_cache(
    account: &crate::codex_account::CodexAccount,
    updates: Vec<crate::codex_limits::CodexRateLimitSnapshot>,
    scan_started_at: i64,
) -> Vec<crate::codex_limits::CodexRateLimitSnapshot> {
    let Ok(mut cache) = SNAPSHOT_CACHE.lock() else {
        return updates;
    };
    let current = cache.get_or_insert_with(|| SnapshotCache {
        account_id: account.account_id.clone(),
        last_scan_ms: account.auth_started_at_ms,
        snapshots: HashMap::new(),
    });
    if current.account_id != account.account_id {
        *current = SnapshotCache {
            account_id: account.account_id.clone(),
            last_scan_ms: account.auth_started_at_ms,
            snapshots: HashMap::new(),
        };
    }
    merge_snapshots(&mut current.snapshots, updates);
    current.last_scan_ms = scan_started_at;
    current.snapshots.values().cloned().collect()
}

fn merge_snapshots(
    current: &mut HashMap<String, crate::codex_limits::CodexRateLimitSnapshot>,
    updates: Vec<crate::codex_limits::CodexRateLimitSnapshot>,
) {
    for snapshot in updates {
        let replace = current
            .get(&snapshot.limit_id)
            .is_none_or(|existing| snapshot.observed_at >= existing.observed_at);
        if replace {
            current.insert(snapshot.limit_id.clone(), snapshot);
        }
    }
}

fn is_waiting(deadline: &Mutex<Option<Instant>>) -> bool {
    deadline
        .lock()
        .ok()
        .and_then(|value| *value)
        .is_some_and(|until| Instant::now() < until)
}

fn set_deadline(deadline: &Mutex<Option<Instant>>, duration: Duration) {
    if let Ok(mut value) = deadline.lock() {
        *value = Some(Instant::now() + duration);
    }
}

#[cfg(test)]
mod tests {
    use super::merge_snapshots;
    use crate::codex_limits::CodexRateLimitSnapshot;
    use std::collections::HashMap;

    fn snapshot(limit_id: &str, observed_at: i64) -> CodexRateLimitSnapshot {
        CodexRateLimitSnapshot {
            limit_id: limit_id.to_owned(),
            limit_name: None,
            plan_type: None,
            primary: None,
            secondary: None,
            observed_at,
        }
    }

    #[test]
    fn test_incremental_merge_retains_unchanged_models_and_rejects_older_updates() {
        let mut current = HashMap::from([("model".to_owned(), snapshot("model", 20))]);

        merge_snapshots(
            &mut current,
            vec![snapshot("codex", 30), snapshot("model", 10)],
        );

        assert_eq!(current.len(), 2);
        assert_eq!(current["model"].observed_at, 20);
        assert_eq!(current["codex"].observed_at, 30);
    }
}
