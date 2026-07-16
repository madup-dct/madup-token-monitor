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
