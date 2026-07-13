import { useQuery } from "@tanstack/react-query";
import { buildMockCodexRateLimits } from "@/mocks/usageLimitMock";
import type { CodexRateLimitSnapshot } from "@/types/models";

const IS_MOCK = !("__TAURI_INTERNALS__" in window);

export interface OAuthUsageWindow {
  utilization: number;
  resets_at: string;
}

export interface OAuthUsage {
  five_hour: OAuthUsageWindow | null;
  seven_day: OAuthUsageWindow | null;
  seven_day_sonnet: OAuthUsageWindow | null;
  seven_day_opus: OAuthUsageWindow | null;
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
  return {
    five_hour: {
      utilization: 42.5,
      resets_at: new Date(now + 2 * 60 * 60_000).toISOString(),
    },
    seven_day: {
      utilization: 18,
      resets_at: new Date(now + 5 * 86_400_000).toISOString(),
    },
    seven_day_sonnet: null,
    seven_day_opus: null,
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
