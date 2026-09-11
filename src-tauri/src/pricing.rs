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
    #[serde(default)]
    long_context: Option<LongContextPrice>,
    /// cache read 단가 = input × 배율. 생략 시 Anthropic 표준 0.1.
    /// 모델별 예외(Fable/Mythos 5.1, OpenAI 구형 모델)는 pricing.json에 명시.
    #[serde(default)]
    cache_read_multiplier: Option<f64>,
}

const DEFAULT_CACHE_READ_MULTIPLIER: f64 = 0.1;

#[derive(Debug, Clone, Deserialize)]
struct LongContextPrice {
    above_input_tokens: i64,
    input_usd_per_mtok: f64,
    output_usd_per_mtok: f64,
}

type PriceTable = HashMap<String, ModelPrice>;

/// (단가표, 원본 JSON 텍스트) — 텍스트는 지문(fingerprint) 계산용으로 보관.
static PRICE_TABLE: OnceLock<(PriceTable, String)> = OnceLock::new();

fn load_price_table() -> (PriceTable, String) {
    // 우선순위: 사용자 ~/.claude/pricing.json (override) → embedded (compile-time)
    if let Some(home) = dirs::home_dir() {
        let user = home.join(".claude").join("pricing.json");
        if let Ok(text) = fs::read_to_string(&user) {
            if let Ok(table) = serde_json::from_str::<PriceTable>(&text) {
                return (table, text);
            }
        }
    }

    // dev cwd fallback (src-tauri 에서 cargo run 할 때)
    let cwd_candidate = PathBuf::from("pricing.json");
    if cwd_candidate.exists() {
        if let Ok(text) = fs::read_to_string(&cwd_candidate) {
            if let Ok(table) = serde_json::from_str::<PriceTable>(&text) {
                return (table, text);
            }
        }
    }

    (
        serde_json::from_str(EMBEDDED_PRICING).unwrap_or_default(),
        EMBEDDED_PRICING.to_owned(),
    )
}

pub fn price_table() -> &'static PriceTable {
    &PRICE_TABLE.get_or_init(load_price_table).0
}

/// 적용 중인 단가표의 지문. db::migrate 가 이전 기동의 지문과 비교해 단가표가 바뀐
/// 첫 기동에만 cost 를 전량 재계산한다 (기동마다 풀스캔 방지). 해시는 Rust 버전에
/// 무관하게 안정적이어야 하므로 std DefaultHasher 대신 FNV-1a 를 직접 쓴다.
pub fn price_table_fingerprint() -> String {
    let text = &PRICE_TABLE.get_or_init(load_price_table).1;
    format!("{:016x}", fnv1a_64(text.as_bytes()))
}

fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
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
        // 긴 컨텍스트 요율은 캐시를 포함한 요청 전체 입력으로 판정한다.
        // 출력/추론 토큰 수와 누적 세션 토큰 수는 임계값에 포함하지 않는다.
        let prompt_tokens = input_tokens
            .saturating_add(cache_read)
            .saturating_add(cache_write_5m)
            .saturating_add(cache_write_1h);
        let (input_rate, output_rate) = p
            .long_context
            .as_ref()
            .filter(|tier| prompt_tokens > tier.above_input_tokens)
            .map(|tier| (tier.input_usd_per_mtok, tier.output_usd_per_mtok))
            .unwrap_or((p.input_usd_per_mtok, p.output_usd_per_mtok));
        let input_cost = (input_tokens as f64 / 1_000_000.0) * input_rate;
        let output_cost = (output_tokens as f64 / 1_000_000.0) * output_rate;
        // 캐시 읽기는 모델별 배율. Anthropic 5m / OpenAI cache write는 input * 1.25,
        // Anthropic 1h cache write는 input * 2.0이다.
        let cache_read_rate =
            input_rate * p.cache_read_multiplier.unwrap_or(DEFAULT_CACHE_READ_MULTIPLIER);
        let cache_read_cost = (cache_read as f64 / 1_000_000.0) * cache_read_rate;
        let cache_write_5m_cost = (cache_write_5m as f64 / 1_000_000.0) * input_rate * 1.25;
        let cache_write_1h_cost = (cache_write_1h as f64 / 1_000_000.0) * input_rate * 2.0;
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
    fn test_calc_cost_gpt_6_astra_standard_rates() {
        // https://developers.openai.com/api/docs/models/gpt-6-astra
        // Standard rates per 1M: input $10, cached input $1, output $50.
        for model in ["gpt-6-astra", "gpt-6-astra-2026-09-03"] {
            let cost = calc_cost_usd(model, 60_000, 1_000, 40_000, 0, 0);
            assert!((cost - 0.69).abs() < 1e-9, "{model} cost={cost}");
        }
    }

    #[test]
    fn test_calc_cost_gpt_6_astra_long_context_boundary_includes_cache() {
        // Only requests ABOVE 272K input tokens use 2x input/cache and 1.5x output.
        let at_limit = calc_cost_usd("gpt-6-astra", 172_000, 1_000, 100_000, 0, 0);
        let above_limit = calc_cost_usd("gpt-6-astra", 172_001, 1_000, 100_000, 0, 0);
        assert!((at_limit - 1.87).abs() < 1e-9, "at_limit={at_limit}");
        assert!(
            (above_limit - 3.71502).abs() < 1e-9,
            "above_limit={above_limit}"
        );
    }

    #[test]
    fn test_calc_cost_gpt_6_astra_large_output_does_not_trigger_long_context() {
        let cost = calc_cost_usd("gpt-6-astra", 100_000, 200_000, 0, 0, 0);
        assert!((cost - 11.0).abs() < 1e-9, "cost={cost}");
    }

    #[test]
    fn test_calc_cost_gpt_5_6_tiers() {
        // https://developers.openai.com/api/docs/pricing — Standard, short context.
        for (model, expected) in [
            ("gpt-5.6-sol", 2.4),
            ("gpt-5.6", 2.4),
            ("gpt-5.6-terra", 1.4),
            ("gpt-5.6-luna", 0.14),
        ] {
            let cost = calc_cost_usd(model, 100_000, 100_000, 0, 0, 0);
            assert!((cost - expected).abs() < 1e-9, "{model} cost={cost}");
        }
    }

    #[test]
    fn test_calc_cost_gpt_5_6_cache_read_discount() {
        for (model, expected) in [
            ("gpt-5.6-sol", 0.04),
            ("gpt-5.6-terra", 0.02),
            ("gpt-5.6-luna", 0.002),
        ] {
            let cost = calc_cost_usd(model, 0, 0, 100_000, 0, 0);
            assert!((cost - expected).abs() < 1e-9, "{model} cost={cost}");
        }
    }

    #[test]
    fn test_openai_long_context_boundary() {
        // 입력 272K에서는 기본 요율, 272K+1에서는 요청 전체에 긴 입력 요율 적용.
        for (model, at_expected, above_expected) in [
            ("gpt-5.6-sol", 1.108, 2.206008),
            ("gpt-5.6", 1.108, 2.206008),
            ("gpt-5.6-terra", 0.556, 1.106004),
            ("gpt-5.6-luna", 0.0556, 0.1106004),
            ("gpt-5.5", 1.39, 2.76501),
            ("gpt-5.5-pro", 8.34, 16.59006),
            ("gpt-5.4", 0.695, 1.382505),
            ("gpt-5.4-pro", 8.34, 16.59006),
        ] {
            let at = calc_cost_usd(model, 272_000, 1_000, 0, 0, 0);
            let above = calc_cost_usd(model, 272_001, 1_000, 0, 0, 0);
            assert!((at - at_expected).abs() < 1e-9, "{model} at={at}");
            assert!(
                (above - above_expected).abs() < 1e-9,
                "{model} above={above}"
            );
        }
    }

    #[test]
    fn test_openai_long_context_counts_cache_reads_and_writes() {
        // 172K fresh + 50K read + 50K write = 272K; 1 extra write crosses the threshold.
        let at = calc_cost_usd("gpt-5.6-sol", 172_000, 1_000, 50_000, 50_000, 0);
        let above = calc_cost_usd("gpt-5.6-sol", 172_000, 1_000, 50_000, 50_001, 0);
        assert!((at - 0.978).abs() < 1e-9, "at={at}");
        assert!((above - 1.94601).abs() < 1e-9, "above={above}");
    }

    #[test]
    fn test_openai_mini_nano_do_not_inherit_long_context_tier() {
        for (model, expected) in [("gpt-5.4-mini", 1.2), ("gpt-5.4-nano", 0.325)] {
            let cost = calc_cost_usd(model, 1_000_000, 100_000, 0, 0, 0);
            assert!((cost - expected).abs() < 1e-9, "{model} cost={cost}");
        }
    }

    #[test]
    fn test_openai_legacy_input_output_and_cached_rates() {
        // 100K input + 100K cached + 10K output; Standard table / legacy model pages.
        for (model, expected) in [
            ("gpt-4.1", 0.33),
            ("gpt-4.1-mini", 0.066),
            ("gpt-4o", 0.475),
            ("gpt-4o-mini", 0.0285),
            ("o3", 0.33),
            ("o4-mini", 0.1815),
            ("o3-mini", 0.209),
            ("o1", 2.85),
            ("o1-mini", 0.209),
            ("gpt-5.2-codex", 0.3325),
            ("codex-mini-latest", 0.2475),
        ] {
            let cost = calc_cost_usd(model, 100_000, 10_000, 100_000, 0, 0);
            assert!((cost - expected).abs() < 1e-9, "{model} cost={cost}");
        }
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

    // 회귀: Sonnet 5 는 공식 $2/$10 (introductory 가 정식 단가로 확정, 2026-09).
    // 키가 없으면 generic claude-sonnet($3/$15)으로 1.5배 과대 계상됐다.
    #[test]
    fn test_calc_cost_sonnet_5_official_rates() {
        let cost = calc_cost_usd("claude-sonnet-5", 1_000_000, 1_000_000, 0, 0, 0);
        assert!(
            (cost - 12.0).abs() < 0.001,
            "sonnet-5 cost={cost} (expected 2+10=12, not 18)"
        );
        let cache_read = calc_cost_usd("claude-sonnet-5", 0, 0, 1_000_000, 0, 0);
        assert!(
            (cache_read - 0.2).abs() < 0.001,
            "sonnet-5 cache read={cache_read} (expected 0.2)"
        );
        // 레거시 Sonnet 4.x 는 $3/$15 유지
        let legacy = calc_cost_usd("claude-sonnet-4-6", 1_000_000, 0, 0, 0, 0);
        assert!((legacy - 3.0).abs() < 0.001, "sonnet-4-6 cost={legacy}");
    }

    // 회귀: Fable 5.1 은 cache read 만 0.025x($0.25/MTok). 나머지 항목은 Fable 5 와 동일.
    // 키가 없으면 claude-fable-5 로 매칭돼 cache read 가 4배($1.00) 과대 계상됐다.
    #[test]
    fn test_calc_cost_fable_5_1_cache_read_multiplier() {
        let read = calc_cost_usd("claude-fable-5-1", 0, 0, 1_000_000, 0, 0);
        assert!(
            (read - 0.25).abs() < 0.001,
            "fable-5-1 cache read={read} (expected 0.25, not 1.0)"
        );
        let variant = calc_cost_usd("claude-fable-5-1[1m]", 0, 0, 1_000_000, 0, 0);
        assert!((variant - 0.25).abs() < 0.001, "fable-5-1[1m] cache read={variant}");
        // input/output/cache write 는 Fable 5 와 동일: 10 + 50 + 12.5 + 20
        let rest = calc_cost_usd("claude-fable-5-1", 1_000_000, 1_000_000, 0, 1_000_000, 1_000_000);
        assert!((rest - 92.5).abs() < 0.001, "fable-5-1 rest={rest}");
        // Fable 5 는 표준 0.1x 유지
        let fable5 = calc_cost_usd("claude-fable-5", 0, 0, 1_000_000, 0, 0);
        assert!((fable5 - 1.0).abs() < 0.001, "fable-5 cache read={fable5}");
    }

    // Mythos 5.1 / 5 는 Fable 과 같은 $10/$50 이고 5.1 만 cache read 0.025x (공식 각주 1).
    // 키가 없으면 어떤 fallback 에도 안 잡혀 cost=0 (§6.8 사고 유형).
    #[test]
    fn test_calc_cost_mythos_not_zero() {
        let m51 = calc_cost_usd("claude-mythos-5-1", 1_000_000, 1_000_000, 1_000_000, 0, 0);
        assert!((m51 - 60.25).abs() < 0.001, "mythos-5-1 cost={m51} (expected 10+50+0.25)");
        let m5 = calc_cost_usd("claude-mythos-5", 1_000_000, 1_000_000, 1_000_000, 0, 0);
        assert!((m5 - 61.0).abs() < 0.001, "mythos-5 cost={m5} (expected 10+50+1.0)");
    }

    // 단가표 지문은 같은 프로세스에서 안정적이다 (embedded 또는 ~/.claude/pricing.json
    // override 중 실제 로드된 텍스트의 FNV-1a).
    #[test]
    fn test_price_table_fingerprint_is_stable() {
        assert_eq!(fnv1a_64(b""), 0xcbf29ce484222325, "FNV-1a offset basis");
        assert_eq!(fnv1a_64(b"a"), 0xaf63dc4c8601ec8c, "FNV-1a 'a'");
        let first = price_table_fingerprint();
        assert!(!first.is_empty());
        assert_eq!(first, price_table_fingerprint());
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
