use super::{detect_source_for, reset_if_truncated, watch_dirs_for, FileState};
use std::path::Path;

#[test]
fn configured_codex_home_is_watched_and_classified_as_codex() {
    // Given: Codex is running from an isolated home with another account token.
    let home = Path::new("/users/example");
    let codex_home = Path::new("/runtime/codex-home");
    let session = codex_home.join("sessions/2026/07/15/rollout.jsonl");

    // When: the watcher resolves its roots and classifies that session.
    let dirs = watch_dirs_for(home, codex_home);
    let source = detect_source_for(&session, &codex_home.join("sessions"));

    // Then: usage from the configured Codex home enters the Codex pipeline.
    assert!(dirs.contains(&codex_home.join("sessions")));
    assert_eq!(source, "codex");
}

#[test]
fn default_codex_usage_does_not_freeze_when_account_home_differs() {
    // Given: account limits use Orca's isolated Codex home, while a regular
    // Codex CLI session continues writing to the user's default home.
    let home = Path::new("/users/example");
    let account_home = Path::new("/runtime/codex-home");
    let default_session = home.join(".codex/sessions/2026/07/15/rollout.jsonl");

    // When: the watcher resolves every usage root.
    let dirs = watch_dirs_for(home, account_home);
    let source = detect_source_for(&default_session, &account_home.join("sessions"));

    // Then: both session streams remain observable after an account switch.
    assert!(
        dirs.contains(&home.join(".codex/sessions")),
        "default Codex usage root is missing, so its token total will freeze"
    );
    assert!(dirs.contains(&account_home.join("sessions")));
    assert_eq!(source, "codex");
}

#[test]
fn orca_runtime_home_is_codex_even_when_account_home_is_default() {
    // Given: orca 계정 홈이 앱 기동 *후* 생겨 OnceLock 은 기본 ~/.codex 를 가리킨다.
    // 주기 재스캔은 orca 세션을 걷지만, detect_source 는 여전히 기본 홈 sessions 를
    // 인자로 받으므로 orca 경로는 starts_with 브랜치를 못 탄다.
    let default_sessions = Path::new("/users/example/.codex/sessions");
    let orca_session = Path::new(
        "/users/example/Library/Application Support/orca/codex-runtime-home/home/sessions/2026/07/28/rollout.jsonl",
    );

    // When: 기본 홈 sessions 로는 prefix-match 되지 않는 orca 파일을 분류한다.
    let source = detect_source_for(orca_session, default_sessions);

    // Then: `codex-runtime-home` substring 브랜치가 잡아 codex 로 분류된다
    // (없으면 "unknown" 으로 조용히 드롭 → orca 수집 0).
    assert_eq!(source, "codex");
}

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
