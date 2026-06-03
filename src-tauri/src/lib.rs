// ============================================================
// [MODULE MARKER] W2: 파일 워처 + JSONL 파서 + SQLite
// 아래 주석 아래에 mod watcher; mod parser; mod db; 추가
// ============================================================
pub mod commands;
pub mod db;
pub mod models;
pub mod parser;
pub mod plugins;
pub mod pricing;
pub mod watcher;

// ============================================================
// [MODULE MARKER] W4: Supabase 집계 업로드 모듈
// ============================================================
pub mod aggregator;

// ============================================================
// [MODULE MARKER] W5: 시스템 트레이 + 자동 업데이트
// ============================================================
pub mod tray;

// Claude OAuth 사용량 (5h / 7d 한도) — Anthropic의 비공개 endpoint
pub mod oauth_usage;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("안녕하세요, {}! Rust에서 보내는 인사입니다.", name)
}

/// 로컬 데이터(SQLite) 디렉토리 경로. Settings 화면의 "데이터 폴더 열기"가 사용.
#[tauri::command]
fn get_data_dir() -> Result<String, String> {
    db::db_path()
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "데이터 디렉토리를 찾을 수 없습니다".into())
}

/// 메인 윈도우 표시 + 포커스. OAuth deep-link 콜백 도착 직후
/// 백그라운드에서 인증을 처리하는 동안 윈도우가 hidden 상태로 남는 것을 막기 위해 호출.
#[tauri::command]
fn show_main_window(app: tauri::AppHandle) {
    tray::show_main_window(&app);
}

/// 앱 재시작 — 캐시 비우기 / 데이터 삭제 후 변경을 적용(JSONL 전량 재파싱)하려면 재실행이 필요.
/// app.restart() 는 현재 프로세스를 종료하고 새 인스턴스를 실행한다 (반환하지 않음).
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

// ============================================================
// [COMMAND MARKER] W2: get_summary, get_timeseries, get_top_mcp, get_top_plugins
// invoke_handler에 해당 커맨드 추가 필요
// ============================================================

use aggregator::sync_aggregates_now;
use commands::{
    clear_cache_dir, delete_all_data, get_heatmap, get_settings, get_summary, get_timeseries,
    get_today_cost_usd, get_top_mcp, get_top_plugins, get_top_tools, set_setting,
};
use oauth_usage::{get_oauth_usage, refresh_oauth_usage};
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _watcher = watcher::FileWatcher::start().ok();

    tauri::Builder::default()
        // 두 번째 instance가 실행되려 하면 기존 윈도우를 활성화하고 종료한다.
        // Windows/Linux 딥링크 forwarding: single-instance 의 `deep-link` feature 가
        // 이 콜백 실행 *전에* `deep_link.handle_cli_arguments(argv)` 를 호출한다.
        // 그 함수가 `madup-token-monitor://` argv 를 파싱해 `deep-link://new-url` 이벤트를
        // emit 하면, setup() 의 `on_open_url` 핸들러(아래)가 동일 경로로 받는다.
        // → argv 를 여기서 수동 파싱할 필요 없음 (auto-forward). macOS 는 RunEvent::Opened 경로.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            greet,
            get_summary,
            get_timeseries,
            get_top_mcp,
            get_top_plugins,
            get_top_tools,
            get_heatmap,
            get_today_cost_usd,
            get_data_dir,
            show_main_window,
            restart_app,
            sync_aggregates_now,
            get_oauth_usage,
            refresh_oauth_usage,
            get_settings,
            set_setting,
            clear_cache_dir,
            delete_all_data,
        ])
        .setup(|app| {
            tray::setup_tray(app.handle())?;
            tray::spawn_title_updater(app.handle().clone());

            // 사내 전용 앱 — 로그인 시 항상 자동 실행 (사용자 선택 없음). 매 실행마다 보장.
            {
                use tauri_plugin_autostart::ManagerExt;
                let _ = app.autolaunch().enable();
            }
            // Dock 아이콘 숨김 — 트레이/메뉴바 전용(Accessory). 윈도우는 트레이에서 띄운다.
            #[cfg(target_os = "macos")]
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Windows/Linux 가 런타임에 `madup-token-monitor://` 스킴을 OS 레지스트리에 claim.
            // macOS 는 Info.plist 로 이미 등록되므로 이 경로를 건드리지 않는다 (무회귀).
            // 등록 실패(권한 등) 시 로그만 남긴다 — 로그인 딥링크가 안 먹는 원인 추적용.
            #[cfg(not(target_os = "macos"))]
            if let Err(e) = app.deep_link().register_all() {
                eprintln!("deep_link register_all failed: {e}");
            }

            // OAuth deep-link 콜백을 Rust 측에서 직접 처리해 popover 를 띄운다.
            // JS 측 `onOpenUrl` 도 동일하게 처리하지만:
            //   1) JS 이벤트 라우팅이 실패해도 윈도우는 떠야 한다
            //   2) Rust 에서 더 빨리 처리되어 사용자 체감 latency 가 짧다
            // URL 검증 / 세션 설정은 JS 가 그대로 담당한다 (Supabase 클라이언트가 거기 있음).
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    let s = url.as_str();
                    eprintln!("[deep-link] received: {}", s);
                    if s.starts_with("madup-token-monitor://auth/callback") {
                        tray::show_main_window(&handle);
                    }
                }
            });

            Ok(())
        })
        // 풀 윈도우 모드: 트래픽 라이트 빨강(close)은 hide 로 흡수해 트레이로 복귀,
        // 포커스 잃어도 hide 하지 않는다 (popover UX 제거).
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
