import { useQuery } from "@tanstack/react-query";
import { buildMockCodexRateLimits } from "@/mocks/usageLimitMock";
import { supabase } from "@/lib/supabase";
import type {
  CodexRateLimitSnapshot,
  ClaudeAccountLimitRow,
  LimitWindow,
} from "@/types/models";

const IS_MOCK = !("__TAURI_INTERNALS__" in window);

export interface OAuthUsage {
  windows: LimitWindow[];
  fetched_at: string;
  is_stale: boolean;
}

export interface OAuthUsageWithError {
  data: OAuthUsage | null;
  error: string | null;
}

async function tauriInvoke<T>(cmd: string): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd);
}

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), 150));
}

function buildMockOAuthUsage(): OAuthUsage {
  const now = Date.now();
  // 잔여 92 / 58 / 22 — 3단계 색(초록/노랑/빨강)을 dev 에서 모두 확인.
  return {
    windows: [
      {
        kind: "session",
        scope_model: null,
        utilization: 8,
        resets_at: new Date(now + 2 * 3_600_000).toISOString(),
      },
      {
        kind: "weekly_all",
        scope_model: null,
        utilization: 42.5,
        resets_at: new Date(now + 5 * 86_400_000).toISOString(),
      },
      {
        kind: "weekly_scoped",
        scope_model: "Fable",
        utilization: 78,
        resets_at: new Date(now + 5 * 86_400_000).toISOString(),
      },
    ],
    fetched_at: new Date(now).toISOString(),
    is_stale: false,
  };
}

export function useCodexRateLimits() {
  return useQuery<CodexRateLimitSnapshot[]>({
    queryKey: ["codexRateLimits"],
    queryFn: () =>
      IS_MOCK
        ? delay(buildMockCodexRateLimits())
        : tauriInvoke<CodexRateLimitSnapshot[]>("get_codex_rate_limits"),
    staleTime: 30_000,
  });
}

export function useOAuthUsage() {
  return useQuery<OAuthUsageWithError>({
    queryKey: ["oauthUsage"],
    queryFn: async () => {
      if (IS_MOCK) return { data: buildMockOAuthUsage(), error: null };
      try {
        const data = await tauriInvoke<OAuthUsage>("get_oauth_usage");
        return { data, error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[oauth_usage] fetch failed:", message);
        return { data: null, error: message };
      }
    },
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    retry: 1,
  });
}

export async function refreshOAuthUsage(): Promise<OAuthUsageWithError> {
  if (IS_MOCK) return { data: buildMockOAuthUsage(), error: null };
  try {
    const data = await tauriInvoke<OAuthUsage>("refresh_oauth_usage");
    return { data, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { data: null, error: message };
  }
}

function buildMockAccountLimits(): ClaudeAccountLimitRow[] {
  const now = Date.now();
  const reset5h = new Date(now + 2 * 3_600_000).toISOString();
  const resetWk = new Date(now + 5 * 86_400_000).toISOString();
  const acct = (
    uuid: string,
    email: string,
    name: string | null,
    u5: number,
    u7: number,
    uf: number,
    updatedAgoMin: number,
  ): ClaudeAccountLimitRow => ({
    account_uuid: uuid,
    account_email: email,
    owner_email: email,
    owner_name: name,
    windows: [
      { kind: "session", scope_model: null, utilization: u5, resets_at: reset5h },
      { kind: "weekly_all", scope_model: null, utilization: u7, resets_at: resetWk },
      { kind: "weekly_scoped", scope_model: "Fable", utilization: uf, resets_at: resetWk },
    ],
    fetched_at: new Date(now - updatedAgoMin * 60_000).toISOString(),
    updated_at: new Date(now - updatedAgoMin * 60_000).toISOString(),
  });
  return [
    acct("00000000-0000-0000-0000-000000000001", "hong@madup.com", "홍길동", 8, 12, 5, 3),
    acct("00000000-0000-0000-0000-000000000002", "kim@madup.com", "김철수", 59, 37, 48, 7),
    acct("00000000-0000-0000-0000-000000000003", "lee@madup.com", "이영희", 88, 70, 100, 45),
  ];
}

export function useClaudeAccountLimits() {
  return useQuery<ClaudeAccountLimitRow[]>({
    queryKey: ["claudeAccountLimits"],
    queryFn: async () => {
      if (IS_MOCK) return delay(buildMockAccountLimits());
      const { data, error } = await supabase.rpc("get_claude_account_limits");
      if (error) throw new Error(error.message);
      return (data ?? []) as ClaudeAccountLimitRow[];
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
}
