use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

pub const TRAY_ID: &str = "main-tray";

fn show_and_focus<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
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
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        #[cfg(target_os = "macos")]
        {
            let title = if show_text && cost >= 0.5 {
                format!(" ${}", cost.round() as i64)
            } else {
                String::new()
            };
            let _ = tray.set_title(Some(title));
        }
        #[cfg(not(target_os = "macos"))]
        {
            let tooltip = if show_text && cost >= 0.5 {
                format!("매드업 토큰 모니터 — 오늘 ${}", cost.round() as i64)
            } else {
                "매드업 토큰 모니터".to_string()
            };
            let _ = tray.set_tooltip(Some(tooltip));
        }
    }
}

/// 30초마다 오늘(local-tz) USD 비용을 읽어 트레이 타이틀에 반영 (폴백).
/// 실시간 갱신은 watcher 가 파싱 직후 refresh_tray_title 을 직접 호출한다.
pub fn spawn_title_updater<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || loop {
        // 타기기 오늘 비용 — stale(120초)일 때만 Supabase fetch. blocking 은 이 전용 스레드에서만.
        crate::aggregator::refresh_other_devices_cost_if_stale();
        refresh_tray_title(&app);
        std::thread::sleep(std::time::Duration::from_secs(30));
    });
}
