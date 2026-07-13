use rusqlite::{params, Connection};
use std::collections::HashMap;

use crate::db::{open, range_bounds};
use crate::models::{ModelSummary, SourceSummary, Summary};
use crate::pricing::usd_to_krw_rate;

struct SummaryQuery<'a> {
    start: i64,
    end: i64,
    source: Option<&'a str>,
}

#[tauri::command]
pub fn get_summary(range: String, source: Option<String>) -> Result<Summary, String> {
    let connection = open().map_err(|error| error.to_string())?;
    let (start, end) = range_bounds(&range);
    read_summary(
        &connection,
        SummaryQuery {
            start,
            end,
            source: source.as_deref(),
        },
    )
    .map_err(|error| error.to_string())
}

fn read_summary(connection: &Connection, query: SummaryQuery<'_>) -> rusqlite::Result<Summary> {
    let mut statement = connection.prepare(
        "SELECT source, model,
                COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
                COALESCE(SUM(cache_read),0), COALESCE(SUM(cache_write),0),
                COALESCE(SUM(cost_usd),0.0)
         FROM usage_events
         WHERE ts BETWEEN ?1 AND ?2 AND (?3 IS NULL OR source = ?3)
         GROUP BY source, model",
    )?;
    let rows = statement.query_map(params![query.start, query.end, query.source], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, f64>(6)?,
        ))
    })?;

    let mut total_input = 0i64;
    let mut total_output = 0i64;
    let mut total_cache_read = 0i64;
    let mut total_cache_write = 0i64;
    let mut total_cost = 0f64;
    let mut source_map = HashMap::<String, SourceSummary>::new();
    let mut model_map = HashMap::<String, ModelSummary>::new();

    for row in rows.flatten() {
        let (source, model, input, output, cache_read, cache_write, cost) = row;
        total_input += input;
        total_output += output;
        total_cache_read += cache_read;
        total_cache_write += cache_write;
        total_cost += cost;

        let source_summary = source_map.entry(source.clone()).or_insert(SourceSummary {
            source,
            input_tokens: 0,
            output_tokens: 0,
            cost_usd: 0.0,
        });
        source_summary.input_tokens += input;
        source_summary.output_tokens += output;
        source_summary.cost_usd += cost;

        if let Some(model) = model {
            let model_summary = model_map.entry(model.clone()).or_insert(ModelSummary {
                model,
                input_tokens: 0,
                output_tokens: 0,
                cache_read: 0,
                cache_write: 0,
                cost_usd: 0.0,
            });
            model_summary.input_tokens += input;
            model_summary.output_tokens += output;
            model_summary.cache_read += cache_read;
            model_summary.cache_write += cache_write;
            model_summary.cost_usd += cost;
        }
    }

    let message_count = connection.query_row(
        "SELECT COUNT(*) FROM usage_events
         WHERE ts BETWEEN ?1 AND ?2 AND (?3 IS NULL OR source = ?3)",
        params![query.start, query.end, query.source],
        |row| row.get(0),
    )?;
    let session_count = connection.query_row(
        "SELECT COUNT(DISTINCT session_id) FROM usage_events
         WHERE ts BETWEEN ?1 AND ?2 AND session_id IS NOT NULL
           AND (?3 IS NULL OR source = ?3)",
        params![query.start, query.end, query.source],
        |row| row.get(0),
    )?;

    Ok(Summary {
        total_input_tokens: total_input,
        total_output_tokens: total_output,
        total_cache_read,
        total_cache_write,
        total_cost_usd: total_cost,
        total_cost_krw: total_cost * usd_to_krw_rate(),
        message_count,
        session_count,
        by_source: source_map.into_values().collect(),
        by_model: model_map.into_values().collect(),
    })
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::{read_summary, SummaryQuery};

    fn connection() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection
            .execute_batch(
                "CREATE TABLE usage_events (
                    source TEXT NOT NULL, model TEXT, ts INTEGER NOT NULL,
                    input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER,
                    cache_write INTEGER, cost_usd REAL, session_id TEXT
                );
                INSERT INTO usage_events VALUES
                    ('claude', 'claude-opus-4-7', 10, 100, 20, 300, 40, 1.5, 'claude-session'),
                    ('codex', 'gpt-5.6-sol', 11, 50, 10, 150, 0, 0.5, 'codex-session');",
            )
            .expect("summary fixture");
        connection
    }

    #[test]
    fn test_read_summary_filters_every_metric_by_source() {
        let summary = read_summary(
            &connection(),
            SummaryQuery {
                start: 0,
                end: 20,
                source: Some("codex"),
            },
        )
        .expect("codex summary");

        assert_eq!(summary.total_input_tokens, 50);
        assert_eq!(summary.total_cache_read, 150);
        assert_eq!(summary.message_count, 1);
        assert_eq!(summary.session_count, 1);
        assert_eq!(summary.by_source[0].source, "codex");
        assert_eq!(summary.by_model[0].model, "gpt-5.6-sol");
    }

    #[test]
    fn test_read_summary_without_source_combines_all_sources() {
        let summary = read_summary(
            &connection(),
            SummaryQuery {
                start: 0,
                end: 20,
                source: None,
            },
        )
        .expect("combined summary");

        assert_eq!(summary.total_input_tokens, 150);
        assert_eq!(summary.message_count, 2);
        assert_eq!(summary.session_count, 2);
        assert_eq!(summary.by_source.len(), 2);
        assert_eq!(summary.by_model.len(), 2);
    }
}
