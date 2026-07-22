use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;

use crate::codex_limits::{CodexRateLimitSnapshot, RateLimitWindow};
use crate::oauth_usage::LimitWindow;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CodexAccount {
    pub account_id: String,
    pub email: Option<String>,
    pub plan_type: Option<String>,
    #[serde(skip_serializing)]
    pub auth_started_at_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodexLimitUpload {
    pub account_id: String,
    pub account_email: Option<String>,
    pub plan_type: Option<String>,
    pub windows: Vec<LimitWindow>,
    pub fetched_at: String,
}

#[derive(Deserialize)]
struct AuthFile {
    auth_mode: Option<String>,
    tokens: Option<AuthTokens>,
}

#[derive(Deserialize)]
struct AuthTokens {
    account_id: Option<String>,
    id_token: Option<String>,
}

#[derive(Deserialize)]
struct IdTokenClaims {
    email: Option<String>,
    auth_time: Option<i64>,
    #[serde(rename = "https://api.openai.com/auth")]
    openai_auth: Option<OpenAiAuthClaims>,
}

#[derive(Deserialize)]
struct OpenAiAuthClaims {
    chatgpt_account_id: Option<String>,
    chatgpt_plan_type: Option<String>,
}

pub(crate) fn read_codex_account_from(home: &std::path::Path) -> Option<CodexAccount> {
    let path = home.join("auth.json");
    if !fs::symlink_metadata(&path).ok()?.file_type().is_file() {
        return None;
    }
    parse_codex_account(&fs::read_to_string(path).ok()?)
}

fn parse_codex_account(text: &str) -> Option<CodexAccount> {
    let auth = serde_json::from_str::<AuthFile>(text).ok()?;
    if auth.auth_mode.as_deref() == Some("apikey") {
        return None;
    }
    let tokens = auth.tokens?;
    let claims = tokens.id_token.as_deref().and_then(decode_id_token);
    let email = claims.as_ref().and_then(|value| value.email.clone());
    let auth_started_at_ms = claims.as_ref()?.auth_time?.checked_mul(1_000)?;
    let claim_auth = claims.as_ref().and_then(|value| value.openai_auth.as_ref());
    let account_id = tokens
        .account_id
        .or_else(|| claim_auth.and_then(|value| value.chatgpt_account_id.clone()))
        .filter(|value| !value.trim().is_empty())?;
    Some(CodexAccount {
        account_id,
        email,
        plan_type: claim_auth.and_then(|value| value.chatgpt_plan_type.clone()),
        auth_started_at_ms,
    })
}

fn decode_id_token(token: &str) -> Option<IdTokenClaims> {
    let payload = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn build_codex_limit_upload(
    account: &CodexAccount,
    snapshots: &[CodexRateLimitSnapshot],
) -> Option<CodexLimitUpload> {
    let newest_observed_at = snapshots
        .iter()
        .map(|snapshot| snapshot.observed_at)
        .max()?;
    let observation_cutoff = account.auth_started_at_ms;
    let recent_snapshots = snapshots
        .iter()
        .filter(|snapshot| snapshot.observed_at >= observation_cutoff)
        .collect::<Vec<_>>();
    let fetched_at = chrono::DateTime::from_timestamp_millis(newest_observed_at)?.to_rfc3339();
    let plan_type = account.plan_type.clone().or_else(|| {
        recent_snapshots
            .iter()
            .find_map(|snapshot| snapshot.plan_type.clone())
    });
    let mut windows = recent_snapshots
        .iter()
        .flat_map(|snapshot| {
            [snapshot.primary.as_ref(), snapshot.secondary.as_ref()]
                .into_iter()
                .flatten()
                .filter_map(|window| normalize_window(snapshot, window))
        })
        .collect::<Vec<_>>();
    windows.sort_by(|left, right| {
        window_rank(&left.kind)
            .cmp(&window_rank(&right.kind))
            .then_with(|| left.scope_model.cmp(&right.scope_model))
    });
    if windows.is_empty() {
        return None;
    }
    Some(CodexLimitUpload {
        account_id: account.account_id.clone(),
        account_email: account.email.clone(),
        plan_type,
        windows,
        fetched_at,
    })
}

fn window_rank(kind: &str) -> u8 {
    match kind {
        "session" => 0,
        "weekly_all" => 1,
        "weekly_scoped" => 2,
        _ => 3,
    }
}

fn normalize_window(
    snapshot: &CodexRateLimitSnapshot,
    window: &RateLimitWindow,
) -> Option<LimitWindow> {
    let (kind, scope_model) = match (window.window_minutes, snapshot.limit_id.as_str()) {
        (300, _) => ("session", None),
        (10_080, "codex") => ("weekly_all", None),
        (10_080, _) => ("weekly_scoped", model_label(snapshot)),
        (_, _) => ("custom", Some(format!("{}분", window.window_minutes))),
    };
    Some(LimitWindow {
        kind: kind.to_owned(),
        scope_model,
        utilization: window.used_percent,
        resets_at: chrono::DateTime::from_timestamp(window.resets_at, 0)?.to_rfc3339(),
    })
}

fn model_label(snapshot: &CodexRateLimitSnapshot) -> Option<String> {
    snapshot.limit_name.as_deref().map(|name| {
        name.split_once("-Codex-")
            .map_or(name, |(_, suffix)| suffix)
            .to_owned()
    })
}

#[cfg(test)]
#[path = "codex_account_tests.rs"]
mod tests;
