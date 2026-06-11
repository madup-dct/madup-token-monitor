import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Session } from "@supabase/supabase-js";
import { supabase, signInWithSlack } from "./supabase";

export type AuthState = "loading" | "authenticated" | "unauthenticated";

const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/// Slack OAuth 시작.
/// - Tauri (dev / prod): 외부 브라우저 (openUrl) — Slack 이 WKWebView 사용자에이전트를
///   차단하므로 같은 webview 안에서 OAuth 진행 불가. deep-link 로 복귀.
/// - 브라우저 dev: 같은 탭에서 navigate → /login 같은 origin 으로 복귀 (Supabase auto-detect).
export async function startSlackLogin(): Promise<void> {
  const { url } = await signInWithSlack();
  if (!url) throw new Error("OAuth URL is missing");
  if (IS_TAURI) {
    await openUrl(url);
  } else {
    window.location.href = url;
  }
}

// Tauri prod 의 deep-link callback 처리. Supabase 는 흐름에 따라 두 가지 형태로 토큰을 보냄:
//   ① PKCE code flow: ?code=...           → exchangeCodeForSession
//   ② OIDC implicit flow: #access_token=...&refresh_token=... → setSession
export async function handleAuthCallback(url: string): Promise<boolean> {
  try {
    const urlObj = new URL(url);
    const fragment = urlObj.hash.startsWith("#") ? urlObj.hash.slice(1) : "";
    if (fragment) {
      const params = new URLSearchParams(fragment);
      const access_token = params.get("access_token");
      const refresh_token = params.get("refresh_token");
      if (access_token && refresh_token) {
        const { error } = await supabase.auth.setSession({ access_token, refresh_token });
        return !error;
      }
    }
    const code = urlObj.searchParams.get("code");
    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      return !error;
    }
    return false;
  } catch {
    return false;
  }
}

export async function getAuthState(): Promise<AuthState> {
  const { data } = await supabase.auth.getSession();
  return data.session ? "authenticated" : "unauthenticated";
}

/// Rust 메모리 캐시에 Supabase 세션(JWT) 전달 — 트레이의 다기기 오늘 비용 조회용.
/// Rust 는 세션을 영속하지 않으므로 앱 시작 + SIGNED_IN/TOKEN_REFRESHED 마다 호출해야 한다.
export async function pushSessionToRust(session?: Session | null): Promise<void> {
  if (!IS_TAURI) return;
  const s = session ?? (await supabase.auth.getSession()).data.session;
  if (!s) return;

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? "";
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
  if (!supabaseUrl || !publishableKey) return;

  try {
    await invoke("set_supabase_session", {
      supabaseUrl,
      publishableKey,
      accessToken: s.access_token,
      userId: s.user.id,
    });
  } catch (e) {
    // 트레이 다기기 합산은 부가 기능 — 실패해도 로컬 비용 표시는 유지된다.
    console.warn("[session-bridge] set_supabase_session failed:", e);
  }
}

/// 로그아웃 시 Rust 세션·트레이 타기기 비용 캐시 제거 —
/// 이전 사용자 JWT 로 폴링이 계속되거나 이전 사용자 비용이 잔류하는 것을 방지.
export async function clearSessionInRust(): Promise<void> {
  if (!IS_TAURI) return;
  try {
    await invoke("clear_supabase_session");
  } catch (e) {
    console.warn("[session-bridge] clear_supabase_session failed:", e);
  }
}

export interface SyncResult {
  usage_rows: number;
  mcp_rows: number;
  plugin_rows: number;
  hourly_rows: number;
  tool_rows: number;
}

/// force=true 면 워터마크를 무시하고 전체 백필 — 수동 "지금 동기화" 가 사용해
/// 원격 드리프트(수동 정정/복원 등)의 복구 수단이 된다. 자동 sync 는 증분.
export async function syncAggregatesNow(force = false): Promise<SyncResult | null> {
  if (!IS_TAURI) return null;
  const { data: sessionData } = await supabase.auth.getSession();
  const session = sessionData.session;
  if (!session) return null;

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? "";
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
  if (!supabaseUrl || !publishableKey) return null;

  return invoke<SyncResult>("sync_aggregates_now", {
    supabaseUrl,
    publishableKey,
    accessToken: session.access_token,
    userId: session.user.id,
    force,
  });
}
