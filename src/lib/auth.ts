import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
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

export interface SyncResult {
  usage_rows: number;
  mcp_rows: number;
  plugin_rows: number;
  hourly_rows: number;
  tool_rows: number;
}

export async function syncAggregatesNow(): Promise<SyncResult | null> {
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
  });
}
