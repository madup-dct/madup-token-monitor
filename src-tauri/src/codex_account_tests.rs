use super::{build_codex_limit_upload, parse_codex_account, read_codex_account_from, CodexAccount};
use crate::codex_limits::{CodexRateLimitSnapshot, RateLimitWindow};

const AUTH: &str = r#"{
    "auth_mode": "chatgpt",
    "tokens": {
        "account_id": "acct_stable",
        "id_token": "eyJhbGciOiJub25lIn0.eyJlbWFpbCI6ImNvZGV4QGV4YW1wbGUuY29tIiwiYXV0aF90aW1lIjoxNzg0MDUwMDAwLCJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF9jbGFpbSIsImNoYXRncHRfcGxhbl90eXBlIjoicHJvIn19.signature",
        "access_token": "must-not-leak",
        "refresh_token": "must-not-leak"
    }
}"#;

#[test]
fn test_account_metadata_when_chatgpt_auth_uses_stable_account_id() {
    let account = parse_codex_account(AUTH).expect("account metadata");
    assert_eq!(account.account_id, "acct_stable");
    assert_eq!(account.email.as_deref(), Some("codex@example.com"));
    assert_eq!(account.plan_type.as_deref(), Some("pro"));
    let serialized = serde_json::to_string(&account).expect("serialize account");
    assert!(!serialized.contains("must-not-leak"));
}

#[test]
fn test_account_reader_uses_the_resolved_home() {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    let home =
        std::env::temp_dir().join(format!("codex-account-home-{}-{nonce}", std::process::id()));
    std::fs::create_dir_all(&home).expect("create Codex home");
    std::fs::write(home.join("auth.json"), AUTH).expect("write auth fixture");

    let account = read_codex_account_from(&home).expect("account metadata");
    std::fs::remove_dir_all(&home).expect("remove Codex home");

    assert_eq!(account.account_id, "acct_stable");
}

#[test]
fn test_account_metadata_when_stable_id_is_missing_skips_api_key_auth() {
    let auth = r#"{
        "auth_mode":"apikey",
        "OPENAI_API_KEY":"secret",
        "tokens":{"account_id":"stale-account","id_token":null}
    }"#;
    assert_eq!(parse_codex_account(auth), None);
}

#[test]
fn test_upload_when_standard_and_model_limits_normalizes_windows() {
    let account = CodexAccount {
        account_id: "acct_stable".to_owned(),
        email: Some("codex@example.com".to_owned()),
        plan_type: Some("pro".to_owned()),
        auth_started_at_ms: 1_784_050_000_000,
    };
    let snapshots = [
        CodexRateLimitSnapshot {
            limit_id: "codex".to_owned(),
            limit_name: None,
            plan_type: Some("pro".to_owned()),
            primary: Some(RateLimitWindow {
                used_percent: 42.0,
                window_minutes: 300,
                resets_at: 1_784_500_000,
            }),
            secondary: Some(RateLimitWindow {
                used_percent: 21.0,
                window_minutes: 10_080,
                resets_at: 1_784_600_000,
            }),
            observed_at: 1_784_099_000_000,
        },
        CodexRateLimitSnapshot {
            limit_id: "codex_bengalfox".to_owned(),
            limit_name: Some("GPT-5.3-Codex-Spark".to_owned()),
            plan_type: Some("pro".to_owned()),
            primary: Some(RateLimitWindow {
                used_percent: 4.0,
                window_minutes: 10_080,
                resets_at: 1_784_700_000,
            }),
            secondary: None,
            observed_at: 1_784_100_000_000,
        },
    ];
    let upload = build_codex_limit_upload(&account, &snapshots).expect("upload payload");
    assert_eq!(upload.windows.len(), 3);
    assert_eq!(upload.windows[0].kind, "session");
    assert_eq!(upload.windows[1].kind, "weekly_all");
    assert_eq!(upload.windows[2].kind, "weekly_scoped");
    assert_eq!(upload.windows[2].scope_model.as_deref(), Some("Spark"));
    assert_eq!(upload.fetched_at, "2026-07-15T07:20:00+00:00");
}

#[test]
fn test_upload_excludes_snapshots_from_before_current_authentication() {
    let account = CodexAccount {
        account_id: "acct_new".to_owned(),
        email: None,
        plan_type: None,
        auth_started_at_ms: 1_784_050_000_000,
    };
    let old_snapshot = CodexRateLimitSnapshot {
        limit_id: "codex".to_owned(),
        limit_name: None,
        plan_type: None,
        primary: Some(RateLimitWindow {
            used_percent: 90.0,
            window_minutes: 300,
            resets_at: 1_784_500_000,
        }),
        secondary: None,
        observed_at: 1_784_000_000_000,
    };
    assert!(build_codex_limit_upload(&account, &[old_snapshot]).is_none());
}
