use std::sync::Mutex;
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime,
};

pub const TRAY_ID: &str = "main-tray";

/// 마지막 렌더 내용 키 — 동일 내용이면 30초 폴링마다 아이콘 재설정을 생략.
/// 비어 있지 않으면 "현재 커스텀 스트립 아이콘 상태"라는 뜻 (fallback 시 로고 복원 필요).
static LAST_RENDER_KEY: Mutex<String> = Mutex::new(String::new());

/// 메뉴바 다크 여부 캐시 — 블로킹 조회(defaults read)는 폴링 스레드에서만 수행하고,
/// refresh_tray_title(watcher 핫패스)은 이 원자값만 읽는다 (캐시 읽기 전용 제약).
static DARK_MENUBAR: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 블로킹 — defaults read 로 시스템 다크모드를 조회해 캐시에 반영.
/// spawn_title_updater 폴링 스레드(30초)에서만 호출할 것.
#[cfg(target_os = "macos")]
fn refresh_dark_menubar_cache() {
    let dark = std::process::Command::new("defaults")
        .args(["read", "-g", "AppleInterfaceStyle"])
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).contains("Dark"))
        .unwrap_or(false);
    DARK_MENUBAR.store(dark, std::sync::atomic::Ordering::Relaxed);
}

#[cfg(target_os = "macos")]
fn is_dark_menubar() -> bool {
    DARK_MENUBAR.load(std::sync::atomic::Ordering::Relaxed)
}

/// OAuth 캐시의 windows → 트레이 표시 아이템. 리셋 경과 창은 생략(갱신 대기).
fn tray_items_from_usage(
    usage: &crate::oauth_usage::OAuthUsage,
    now: chrono::DateTime<chrono::Utc>,
) -> Vec<crate::tray_render::TrayItem> {
    if usage.is_stale {
        return Vec::new();
    }
    usage
        .windows
        .iter()
        .filter_map(|w| {
            let resets = chrono::DateTime::parse_from_rfc3339(&w.resets_at).ok()?;
            if resets <= now {
                return None;
            }
            let label = match w.kind.as_str() {
                "session" => "5h".to_string(),
                "weekly_all" => "7d".to_string(),
                _ => w
                    .scope_model
                    .as_deref()
                    .unwrap_or(w.kind.as_str())
                    .chars()
                    .next()
                    .map(|c| c.to_ascii_uppercase().to_string())?,
            };
            Some(crate::tray_render::TrayItem {
                label,
                used_pct: w.utilization.clamp(0.0, 100.0),
            })
        })
        .collect()
}

fn show_and_focus<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        // 팝오버 webview 에서는 visibilitychange/focus 가 신뢰성 있게 발화하지 않아
        // react-query refetchOnWindowFocus 가 동작하지 않는다. 표시 시점을 JS 에
        // 직접 알려 stale 화면(캐시 물고 있는 숫자)을 즉시 갱신하게 한다.
        let _ = app.emit("window-shown", ());
    }
}

/// 트레이 아이콘 클릭 + 외부 트리거 (deep-link callback) 공용 진입점.
/// 풀 윈도우 모드에서는 popover 위치 계산 / 자동 hide 가 없으므로 단순히 show + focus.
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    activate_macos_app();
    show_and_focus(app);
}

#[cfg(target_os = "macos")]
fn activate_macos_app() {
    let _ = std::process::Command::new("osascript")
        .args([
            "-e",
            r#"tell application id "com.madup.token-monitor" to activate"#,
        ])
        .spawn();
}

// 트레이 전용 아이콘 — 메뉴바에 어울리는 작은 마크.
const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/tray.png");

pub fn setup_tray<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("매드업 토큰 모니터")
        .show_menu_on_left_click(false);

    if let Ok(icon) = tauri::image::Image::from_bytes(TRAY_ICON_BYTES) {
        builder = builder.icon(icon).icon_as_template(false);
    } else if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon).icon_as_template(false);
    }

    builder
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// 트레이 타이틀을 현재 값으로 1회 갱신.
/// macOS는 메뉴바 아이콘 옆 텍스트, 그 외 OS는 tooltip에 표시.
/// `show_menubar_cost` 설정이 false 면 메뉴바 텍스트는 비워둔다.
/// 폴링(spawn_title_updater) 과 토글 변경 직후(set_setting) 양쪽에서 호출된다.
pub fn refresh_tray_title<R: Runtime>(app: &AppHandle<R>) {
    // 다기기 합산: 로컬(이 기기, SQLite 최신) + 타기기 캐시(없으면 0).
    // 여기서는 캐시 읽기만 — 네트워크 fetch 는 폴링 스레드(spawn_title_updater)가 담당하므로
    // watcher 파싱 직후 즉시 호출돼도 블로킹되지 않는다.
    let cost = crate::commands::today_cost_usd() + crate::aggregator::cached_other_devices_cost();
    let show_text = crate::commands::read_show_menubar_cost();
    let show_limits = crate::commands::read_show_menubar_limits();
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };

    #[cfg(target_os = "macos")]
    {
        let items = if show_limits {
            crate::oauth_usage::cached_usage()
                .map(|u| tray_items_from_usage(&u, chrono::Utc::now()))
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let cost_text =
            (show_text && cost >= 0.5).then(|| format!("${}", cost.round() as i64));

        if !items.is_empty() {
            let dark = is_dark_menubar();
            let key = format!(
                "{:?}|{}|{}",
                cost_text,
                items
                    .iter()
                    .map(|i| format!("{}{}", i.label, i.used_pct.round()))
                    .collect::<Vec<_>>()
                    .join(","),
                dark
            );
            let unchanged = LAST_RENDER_KEY.lock().map(|g| *g == key).unwrap_or(false);
            if unchanged {
                return;
            }
            let logo = tauri::image::Image::from_bytes(TRAY_ICON_BYTES).ok();
            let logo_ref = logo.as_ref().map(|img| (img.rgba(), img.width(), img.height()));
            if let Some((buf, w, h)) = crate::tray_render::render_status_strip(
                logo_ref,
                cost_text.as_deref(),
                &items,
                dark,
            ) {
                let _ = tray.set_icon(Some(tauri::image::Image::new_owned(buf, w, h)));
                let _ = tray.set_title(Some(String::new()));
                if let Ok(mut g) = LAST_RENDER_KEY.lock() {
                    *g = key;
                }
                return;
            }
            // 렌더 실패(폰트 없음 등) → 아래 텍스트 fallback 으로 진행.
        }

        // 한도 off / 캐시 없음 / 렌더 실패 — 기본 로고 + 기존 타이틀 방식.
        let was_custom = LAST_RENDER_KEY.lock().map(|g| !g.is_empty()).unwrap_or(false);
        if was_custom {
            if let Ok(icon) = tauri::image::Image::from_bytes(TRAY_ICON_BYTES) {
                let _ = tray.set_icon(Some(icon));
            }
            if let Ok(mut g) = LAST_RENDER_KEY.lock() {
                g.clear();
            }
        }
        let title = if show_text && cost >= 0.5 {
            format!(" ${}", cost.round() as i64)
        } else {
            String::new()
        };
        let _ = tray.set_title(Some(title));
    }

    #[cfg(not(target_os = "macos"))]
    {
        // 비-macOS: tooltip 에 텍스트로 동일 정보.
        let mut parts: Vec<String> = Vec::new();
        if show_text && cost >= 0.5 {
            parts.push(format!("오늘 ${}", cost.round() as i64));
        }
        if show_limits {
            if let Some(u) = crate::oauth_usage::cached_usage() {
                let items = tray_items_from_usage(&u, chrono::Utc::now());
                if !items.is_empty() {
                    parts.push(
                        items
                            .iter()
                            .map(|i| format!("{} {}%", i.label, i.used_pct.round() as i64))
                            .collect::<Vec<_>>()
                            .join(" · "),
                    );
                }
            }
        }
        let tooltip = if parts.is_empty() {
            "매드업 토큰 모니터".to_string()
        } else {
            format!("매드업 토큰 모니터 — {}", parts.join(" · "))
        };
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

/// 30초마다 오늘(local-tz) USD 비용을 읽어 트레이 타이틀에 반영 (폴백).
/// 실시간 갱신은 watcher 가 파싱 직후 refresh_tray_title 을 직접 호출한다.
pub fn spawn_title_updater<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || loop {
        // 타기기 오늘 비용 — stale(120초)일 때만 Supabase fetch. blocking 은 이 전용 스레드에서만.
        crate::aggregator::refresh_other_devices_cost_if_stale();
        // OAuth 한도 fetch(10분 캐시) — 트레이 표시는 로그인/계정/업로드 쿨다운과 무관하게
        // 항상 캐시를 데운다 (스펙 §2). 업로드 함수는 이 캐시를 재사용한다.
        let _ = crate::oauth_usage::get_usage_blocking();
        crate::aggregator::upload_limit_snapshot_if_fresh();
        #[cfg(target_os = "macos")]
        refresh_dark_menubar_cache();
        refresh_tray_title(&app);
        std::thread::sleep(std::time::Duration::from_secs(30));
    });
}
