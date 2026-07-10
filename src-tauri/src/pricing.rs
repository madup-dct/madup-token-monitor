use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

/// 컴파일 타임에 pricing.json을 binary 안으로 embed.
/// .app/.exe 어디에 두어도 단가표가 항상 함께 따라감.
const EMBEDDED_PRICING: &str = include_str!("../pricing.json");

#[derive(Debug, Clone, Deserialize)]
pub struct ModelPrice {
    pub input_usd_per_mtok: f64,
    pub output_usd_per_mtok: f64,
}

type PriceTable = HashMap<String, ModelPrice>;

static PRICE_TABLE: OnceLock<PriceTable> = OnceLock::new();

fn load_price_table() -> PriceTable {
    // 우선순위: 사용자 ~/.claude/pricing.json (override) → embedded (compile-time)
    if let Some(home) = dirs::home_dir() {
        let user = home.join(".claude").join("pricing.json");
        if let Ok(text) = fs::read_to_string(&user) {
            if let Ok(table) = serde_json::from_str::<PriceTable>(&text) {
                return table;
            }
        }
    }

    // dev cwd fallback (src-tauri 에서 cargo run 할 때)
    let cwd_candidate = PathBuf::from("pricing.json");
    if cwd_candidate.exists() {
        if let Ok(text) = fs::read_to_string(&cwd_candidate) {
            if let Ok(table) = serde_json::from_str::<PriceTable>(&text) {
                return table;
            }
        }
    }

    serde_json::from_str(EMBEDDED_PRICING).unwrap_or_default()
}

pub fn price_table() -> &'static PriceTable {
    PRICE_TABLE.get_or_init(load_price_table)
}

pub fn calc_cost_usd(
    model: &str,
    input_tokens: i64,
    output_tokens: i64,
    cache_read: i64,
    cache_write_5m: i64,
    cache_write_1h: i64,
) -> f64 {
    let table = price_table();
    // Exact → longest-prefix → contains. 가장 긴 매칭이 가장 specific (opus-4-7 vs opus-4).
    let price = table.get(model).or_else(|| {
        table
            .iter()
            .filter(|(k, _)| model.starts_with(k.as_str()) || model.contains(k.as_str()))
            .max_by_key(|(k, _)| k.len())
            .map(|(_, v)| v)
    });

    if let Some(p) = price {
        let input_cost = (input_tokens as f64 / 1_000_000.0) * p.input_usd_per_mtok;
        let output_cost = (output_tokens as f64 / 1_000_000.0) * p.output_usd_per_mtok;
        // Anthropic 공식: cache_read = input * 0.1, cache_write_5m = input * 1.25, cache_write_1h = input * 2.0
        let cache_read_cost = (cache_read as f64 / 1_000_000.0) * p.input_usd_per_mtok * 0.1;
        let cache_write_5m_cost =
            (cache_write_5m as f64 / 1_000_000.0) * p.input_usd_per_mtok * 1.25;
        let cache_write_1h_cost =
            (cache_write_1h as f64 / 1_000_000.0) * p.input_usd_per_mtok * 2.0;
        input_cost + output_cost + cache_read_cost + cache_write_5m_cost + cache_write_1h_cost
    } else {
        0.0
    }
}

// ── FX cache ────────────────────────────────────────────────────────────────

fn fx_cache_path() -> PathBuf {
    let base = dirs::cache_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("madup-token-monitor").join("fx.json")
}

#[derive(Debug, Deserialize, serde::Serialize)]
struct FxCache {
    rate: f64,
    fetched_at: u64, // unix seconds
}

pub fn usd_to_krw_rate() -> f64 {
    let path = fx_cache_path();

    // Try reading cached value (valid for 24 h)
    if path.exists() {
        if let Ok(text) = fs::read_to_string(&path) {
            if let Ok(cache) = serde_json::from_str::<FxCache>(&text) {
                let age = SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs()
                    .saturating_sub(cache.fetched_at);
                if age < 86_400 {
                    return cache.rate;
                }
            }
        }
    }

    // Fetch fresh rate (blocking — called rarely)
    let rate = fetch_krw_rate().unwrap_or(1_350.0); // fallback
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or(Duration::from_secs(0))
        .as_secs();
    let cache = FxCache {
        rate,
        fetched_at: now,
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    if let Ok(text) = serde_json::to_string(&cache) {
        fs::write(&path, text).ok();
    }
    rate
}

fn fetch_krw_rate() -> Option<f64> {
    #[derive(Deserialize)]
    struct FxResp {
        rates: HashMap<String, f64>,
    }
    let resp = ureq::get("https://api.frankfurter.app/latest?from=USD&to=KRW")
        .timeout(Duration::from_secs(5))
        .call()
        .ok()?;
    let body: FxResp = resp.into_json().ok()?;
    body.rates.get("KRW").copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calc_cost_known_model() {
        // claude-3-5-sonnet: $3/Mtok input, $15/Mtok output
        let cost = calc_cost_usd("claude-3-5-sonnet-20241022", 1_000_000, 100_000, 0, 0, 0);
        assert!((cost - 4.5).abs() < 0.001, "cost={cost}");
    }

    #[test]
    fn test_calc_cost_unknown_model() {
        let cost = calc_cost_usd("unknown-model-xyz", 1_000_000, 1_000_000, 0, 0, 0);
        assert_eq!(cost, 0.0);
    }

    #[test]
    fn test_calc_cost_gpt_5_6_tiers() {
        let sol = calc_cost_usd("gpt-5.6-sol", 1_000_000, 1_000_000, 0, 0, 0);
        let terra = calc_cost_usd("gpt-5.6-terra", 1_000_000, 1_000_000, 0, 0, 0);
        let luna = calc_cost_usd("gpt-5.6-luna", 1_000_000, 1_000_000, 0, 0, 0);

        assert!((sol - 35.0).abs() < 0.001, "sol cost={sol}");
        assert!((terra - 17.5).abs() < 0.001, "terra cost={terra}");
        assert!((luna - 7.0).abs() < 0.001, "luna cost={luna}");
    }

    #[test]
    fn test_calc_cost_gpt_5_6_cache_read_discount() {
        let cost = calc_cost_usd("gpt-5.6-sol", 0, 0, 1_000_000, 0, 0);
        assert!((cost - 0.5).abs() < 0.001, "cost={cost}");
    }

    #[test]
    fn test_calc_cost_cache() {
        // sonnet input=$3 → cache_read=$0.3, cache_write_5m=$3.75, cache_write_1h=$6.0
        let cost = calc_cost_usd(
            "claude-3-5-sonnet-20241022",
            0,
            0,
            1_000_000,
            1_000_000,
            1_000_000,
        );
        let expected = 0.3 + 3.75 + 6.0;
        assert!((cost - expected).abs() < 0.001, "cost={cost}");
    }

    // 회귀: Opus 4.8 은 $5/$25 (Opus 4.5+ 세대). 단가표에 4-8 키가 없으면
    // fallback 이 generic "claude-opus-4"($15/$75, 레거시 4.0/4.1)로 잡혀 3배 과대 계상됐다.
    #[test]
    fn test_calc_cost_opus_4_8_not_overcharged() {
        // input 1M → $5 (NOT $15 from the legacy claude-opus-4 fallback)
        let bare = calc_cost_usd("claude-opus-4-8", 1_000_000, 0, 0, 0, 0);
        assert!(
            (bare - 5.0).abs() < 0.001,
            "opus-4-8 bare cost={bare} (expected 5.0, not 15.0)"
        );
        // dated 변형도 starts_with 로 4-8 키(가장 긴 매칭)에 잡혀야 함
        let dated = calc_cost_usd("claude-opus-4-8-20260515", 1_000_000, 1_000_000, 0, 0, 0);
        assert!(
            (dated - 30.0).abs() < 0.001,
            "opus-4-8 dated cost={dated} (expected 5+25=30, not 15+75=90)"
        );
    }

    // 회귀: Fable 5 는 $10/$50. 단가표에 키가 없으면 어떤 fallback 에도 안 잡혀
    // cost=0 으로 집계됐다 (2026-06 전사 7명 $0 누락 사고).
    #[test]
    fn test_calc_cost_fable_5_not_zero() {
        let bare = calc_cost_usd("claude-fable-5", 1_000_000, 1_000_000, 0, 0, 0);
        assert!(
            (bare - 60.0).abs() < 0.001,
            "fable-5 cost={bare} (expected 10+50=60, not 0)"
        );
        // [1m] 컨텍스트 변형도 prefix 매칭으로 잡혀야 함
        let variant = calc_cost_usd("claude-fable-5[1m]", 1_000_000, 0, 0, 0, 0);
        assert!(
            (variant - 10.0).abs() < 0.001,
            "fable-5[1m] cost={variant} (expected 10.0)"
        );
        // 미래 fable-N 도 generic claude-fable 로 $10 fallback
        let future = calc_cost_usd("claude-fable-6", 1_000_000, 0, 0, 0, 0);
        assert!(
            (future - 10.0).abs() < 0.001,
            "fable-6 cost={future} (expected 10.0)"
        );
    }

    // 레거시 Opus 4.1 은 여전히 $15/$75 (명시 키 보존 확인)
    #[test]
    fn test_calc_cost_opus_4_1_legacy_price() {
        let cost = calc_cost_usd("claude-opus-4-1", 1_000_000, 0, 0, 0, 0);
        assert!(
            (cost - 15.0).abs() < 0.001,
            "opus-4-1 cost={cost} (expected 15.0)"
        );
    }

    // 재발 방지: generic "claude-opus-4" 기본값을 $5 로 내려, 단가표에 없는 미래 opus-4-N
    // (4.9 등)이 $15 fallback 으로 과대 계상되지 않게 한다. 동시에 레거시 4.0 은 명시 키로 $15 보존.
    #[test]
    fn test_calc_cost_opus_generic_default_and_legacy_pins() {
        // 미등록 미래 모델 → generic claude-opus-4 = $5 (옛 $15 아님)
        let future = calc_cost_usd("claude-opus-4-9", 1_000_000, 0, 0, 0, 0);
        assert!(
            (future - 5.0).abs() < 0.001,
            "opus-4-9 cost={future} (expected 5.0, not 15.0)"
        );
        // 레거시 Opus 4.0 (dated id) 는 명시 핀으로 $15 유지
        let legacy = calc_cost_usd("claude-opus-4-20250514", 1_000_000, 0, 0, 0, 0);
        assert!(
            (legacy - 15.0).abs() < 0.001,
            "opus-4.0 dated cost={legacy} (expected 15.0)"
        );
        let legacy0 = calc_cost_usd("claude-opus-4-0", 1_000_000, 0, 0, 0, 0);
        assert!(
            (legacy0 - 15.0).abs() < 0.001,
            "opus-4-0 cost={legacy0} (expected 15.0)"
        );
    }
}
