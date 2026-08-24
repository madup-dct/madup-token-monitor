//! 로컬 보존기간 정책 — "이번 달 + 직전 2개 달력 월" 만 SQLite 에 남기고 나머지는 삭제.
//!
//! 컷오프 = (이번 달 1일) − 2개월. 예: 2026-08-24 → 2026-06-01 00:00 (local) 미만 삭제.
//! Supabase 쪽 `retention_cutoff_date()` 와 같은 정의를 쓴다 (CLAUDE.md §6.9 — 날짜
//! 경계는 KST 달력 기준으로 양쪽을 일치시킬 것).
//!
//! ⚠️ 삭제만으로는 부족하다: watcher 의 파일 offset 은 메모리 전용이라 재시작하면 JSONL 을
//! 전량 재파싱한다. 컷오프 이전 이벤트가 매 기동마다 되살아나지 않도록 삽입 경로
//! (`watcher::persist`)에서도 같은 컷오프로 거른다.

use chrono::{Datelike, Local, Months, NaiveDate, TimeZone};
use rusqlite::{params, Connection, Result};

use crate::db::{SYNC_WM_TOOL, SYNC_WM_USAGE};

/// 보존할 "직전 달력 월" 수. 이번 달은 항상 포함되므로 실제 보관은 최대 3개 달력 월,
/// 최소 2개월치 (월초 기준) 가 된다.
const RETENTION_MONTHS: u32 = 2;

/// 주기 실행 간격 — 월 경계를 넘긴 뒤 늦어도 이 간격 안에 정리된다.
/// (수 주간 재기동 없이 도는 사용자가 있어 기동 1회만으로는 부족하다.)
const PURGE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(6 * 3600);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PurgeStats {
    pub deleted_events: usize,
    pub deleted_calls: usize,
    pub cutoff_ms: i64,
}

impl PurgeStats {
    fn deleted_any(&self) -> bool {
        self.deleted_events > 0 || self.deleted_calls > 0
    }
}

/// 보존 컷오프 날짜 — 이 날짜 00:00 (local) 이전 데이터가 삭제 대상.
pub fn cutoff_date(today: NaiveDate) -> NaiveDate {
    let first_of_month = today.with_day(1).unwrap_or(today);
    first_of_month
        .checked_sub_months(Months::new(RETENTION_MONTHS))
        .unwrap_or(first_of_month)
}

/// 보존 컷오프의 unix-ms (local 자정).
pub fn cutoff_ms_for(today: NaiveDate) -> i64 {
    let date = cutoff_date(today);
    let naive = date.and_time(chrono::NaiveTime::MIN);
    // DST 로 자정이 존재하지 않거나 중복되는 타임존 방어. db.rs 처럼 now 로 폴백하면
    // 컷오프가 "지금"이 되어 전체 삭제가 되므로, 그 대신 같은 날짜의 UTC 자정을 쓴다
    // (최대 14시간 오차 — 경계가 하루 어긋날 뿐 파괴적이지 않다).
    Local
        .from_local_datetime(&naive)
        .earliest()
        .map(|dt| dt.timestamp_millis())
        .unwrap_or_else(|| chrono::Utc.from_utc_datetime(&naive).timestamp_millis())
}

/// 현재 시각 기준 보존 컷오프 unix-ms.
pub fn cutoff_ms() -> i64 {
    cutoff_ms_for(Local::now().date_naive())
}

/// 컷오프 이전 usage_events / tool_calls 삭제.
///
/// 워터마크 방어: `id` 는 AUTOINCREMENT 가 아니라 테이블이 비면 rowid 가 1 부터 재사용된다.
/// 그 상태로 증분 sync 워터마크(MAX(id))가 남아 있으면 신규 이벤트가 영구 누락되므로
/// (CLAUDE.md §7) 테이블이 비었을 때만 해당 워터마크를 지운다. 가장 오래된 row 만 지우는
/// 평시에는 MAX(id) 가 그대로라 워터마크를 건드릴 이유가 없다.
pub fn purge_before(conn: &Connection, cutoff_ms: i64) -> Result<PurgeStats> {
    let tx = conn.unchecked_transaction()?;

    let deleted_events = tx.execute(
        "DELETE FROM usage_events WHERE ts < ?1",
        params![cutoff_ms],
    )?;
    let deleted_calls = tx.execute("DELETE FROM tool_calls WHERE ts < ?1", params![cutoff_ms])?;

    if deleted_events > 0 && is_empty(&tx, "usage_events")? {
        tx.execute("DELETE FROM sync_state WHERE key = ?1", params![SYNC_WM_USAGE])?;
    }
    if deleted_calls > 0 && is_empty(&tx, "tool_calls")? {
        tx.execute("DELETE FROM sync_state WHERE key = ?1", params![SYNC_WM_TOOL])?;
    }

    tx.commit()?;
    Ok(PurgeStats {
        deleted_events,
        deleted_calls,
        cutoff_ms,
    })
}

fn is_empty(conn: &Connection, table: &str) -> Result<bool> {
    // table 은 이 모듈 내부의 리터럴만 전달된다 (사용자 입력 아님).
    let sql = format!("SELECT EXISTS(SELECT 1 FROM {table})");
    let exists: i64 = conn.query_row(&sql, [], |r| r.get(0))?;
    Ok(exists == 0)
}

/// 컷오프 이전 데이터를 지우고, 실제로 지운 게 있으면 파일 크기까지 회수(VACUUM).
fn purge_and_compact(conn: &Connection) -> Result<PurgeStats> {
    let stats = purge_before(conn, cutoff_ms())?;
    if stats.deleted_any() {
        // VACUUM 은 트랜잭션 밖에서만 가능. 실패해도(동시 쓰기 경합 등) 다음 주기에 재시도.
        if let Err(e) = conn.execute_batch("VACUUM") {
            eprintln!("[retention] vacuum skipped: {e}");
        }
    }
    Ok(stats)
}

/// 보존 정리 백그라운드 루프 — 기동 직후 1회 + 6시간 주기.
/// setup(메인 스레드)에서 동기 실행하면 최초 대량 삭제·VACUUM 이 창을 인질로 잡는다
/// (CLAUDE.md §6.13 — 기동 시 무거운 작업은 setup 밖에서).
pub fn spawn_purge_loop() {
    let spawned = std::thread::Builder::new()
        .name("retention-purge".into())
        .spawn(|| loop {
            match crate::db::open() {
                Ok(conn) => match purge_and_compact(&conn) {
                    Ok(stats) if stats.deleted_any() => eprintln!(
                        "[retention] purged events={} calls={} (cutoff_ms={})",
                        stats.deleted_events, stats.deleted_calls, stats.cutoff_ms
                    ),
                    Ok(_) => {}
                    Err(e) => eprintln!("[retention] purge failed: {e}"),
                },
                Err(e) => eprintln!("[retention] database open failed: {e}"),
            }
            std::thread::sleep(PURGE_INTERVAL);
        });
    if let Err(e) = spawned {
        eprintln!("[retention] purge thread spawn failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{get_sync_state, migrate, set_sync_state};

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    // 사용자 요구: 현재월이 8월이면 6월 이전이 삭제 대상 (= 6/1 이 컷오프).
    #[test]
    fn cutoff_is_first_day_two_months_back() {
        assert_eq!(cutoff_date(date(2026, 8, 24)), date(2026, 6, 1));
        assert_eq!(cutoff_date(date(2026, 8, 1)), date(2026, 6, 1));
        assert_eq!(cutoff_date(date(2026, 8, 31)), date(2026, 6, 1));
    }

    // 연도 경계 — 1월/2월은 전년도로 넘어간다.
    #[test]
    fn cutoff_crosses_year_boundary() {
        assert_eq!(cutoff_date(date(2026, 1, 5)), date(2025, 11, 1));
        assert_eq!(cutoff_date(date(2026, 2, 28)), date(2025, 12, 1));
        assert_eq!(cutoff_date(date(2026, 12, 31)), date(2026, 10, 1));
    }

    // 말일(31일) 기준이어도 "1일로 내린 뒤 빼기" 라 짧은 달로 흘러넘치지 않는다.
    #[test]
    fn cutoff_never_overflows_short_months() {
        assert_eq!(cutoff_date(date(2026, 3, 31)), date(2026, 1, 1));
        assert_eq!(cutoff_date(date(2026, 5, 31)), date(2026, 3, 1));
    }

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn
    }

    fn insert_event(conn: &Connection, ts: i64, msg: &str) {
        conn.execute(
            "INSERT INTO usage_events (source, model, ts, input_tokens, cost_usd, message_id, request_id)
             VALUES ('claude', 'claude-opus-4-8', ?1, 100, 1.0, ?2, ?2)",
            params![ts, msg],
        )
        .unwrap();
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn purge_deletes_only_rows_before_cutoff() {
        let conn = test_conn();
        let cutoff = 1_000_000i64;
        insert_event(&conn, cutoff - 1, "old");
        insert_event(&conn, cutoff, "boundary");
        insert_event(&conn, cutoff + 1, "new");
        conn.execute(
            "INSERT INTO tool_calls (source, ts, tool_name) VALUES ('claude', ?1, 'Read'),
                                                                  ('claude', ?2, 'Edit')",
            params![cutoff - 1, cutoff],
        )
        .unwrap();

        let stats = purge_before(&conn, cutoff).unwrap();

        assert_eq!(stats.deleted_events, 1, "컷오프 미만 1건만 삭제");
        assert_eq!(stats.deleted_calls, 1);
        assert_eq!(count(&conn, "usage_events"), 2, "컷오프 시점(=경계)은 보존");
        assert_eq!(count(&conn, "tool_calls"), 1);
    }

    // 회귀: 남은 row 가 있으면 MAX(id) 가 그대로라 워터마크를 유지해야 한다
    // (지웠다고 매번 리셋하면 전체 재업로드가 반복된다).
    #[test]
    fn purge_keeps_watermarks_when_rows_remain() {
        let conn = test_conn();
        insert_event(&conn, 100, "old");
        insert_event(&conn, 300, "new");
        set_sync_state(&conn, SYNC_WM_USAGE, "2").unwrap();
        set_sync_state(&conn, SYNC_WM_TOOL, "7").unwrap();

        purge_before(&conn, 200).unwrap();

        assert_eq!(get_sync_state(&conn, SYNC_WM_USAGE).as_deref(), Some("2"));
        assert_eq!(get_sync_state(&conn, SYNC_WM_TOOL).as_deref(), Some("7"));
    }

    // 회귀: 테이블이 비면 rowid 가 1 부터 재사용되므로(id 는 AUTOINCREMENT 아님)
    // 워터마크를 지워야 신규 이벤트가 영구 누락되지 않는다 (CLAUDE.md §7).
    #[test]
    fn purge_resets_watermark_when_table_emptied() {
        let conn = test_conn();
        insert_event(&conn, 100, "old");
        conn.execute(
            "INSERT INTO tool_calls (source, ts, tool_name) VALUES ('claude', 100, 'Read')",
            [],
        )
        .unwrap();
        set_sync_state(&conn, SYNC_WM_USAGE, "1").unwrap();
        set_sync_state(&conn, SYNC_WM_TOOL, "1").unwrap();

        purge_before(&conn, 200).unwrap();

        assert_eq!(count(&conn, "usage_events"), 0);
        assert_eq!(get_sync_state(&conn, SYNC_WM_USAGE), None, "빈 테이블 → 워터마크 리셋");
        assert_eq!(get_sync_state(&conn, SYNC_WM_TOOL), None);
    }

    // 지울 게 없으면 워터마크는 물론 아무것도 건드리지 않는다 (멱등).
    #[test]
    fn purge_is_noop_when_nothing_is_old() {
        let conn = test_conn();
        insert_event(&conn, 300, "new");
        set_sync_state(&conn, SYNC_WM_USAGE, "1").unwrap();

        let stats = purge_before(&conn, 200).unwrap();

        assert_eq!(stats.deleted_events, 0);
        assert_eq!(stats.deleted_calls, 0);
        assert_eq!(count(&conn, "usage_events"), 1);
        assert_eq!(get_sync_state(&conn, SYNC_WM_USAGE).as_deref(), Some("1"));
    }
}
