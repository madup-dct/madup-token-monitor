import { useQuery } from "@tanstack/react-query";
import type { Summary, Point, McpUsage, PluginUsage, DayCount, Range, ToolUsage } from "@/types/models";
import {
  buildMockSummary,
  buildMockTimeseries,
  buildMockTopMcp,
  buildMockTopPlugins,
  buildMockTopTools,
  buildMockHeatmap,
  buildMockCompanyTopMcp,
} from "@/mocks/usageMock";
import { supabase } from "@/lib/supabase";

const IS_MOCK = !("__TAURI_INTERNALS__" in window);

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

function delay<T>(val: T): Promise<T> {
  return new Promise((r) => setTimeout(() => r(val), 150));
}

export function useSummary(range: Range) {
  return useQuery({
    queryKey: ["summary", range],
    queryFn: () =>
      IS_MOCK
        ? delay(buildMockSummary(range))
        : tauriInvoke<Summary>("get_summary", { range }),
    staleTime: 30_000,
  });
}

// usage_aggregates row (본인 user_id 만 RLS 로 SELECT 허용).
interface MyAggregateRow {
  date: string; // YYYY-MM-DD
  source: string;
  total_input: number;
  total_output: number;
  total_tokens: number;
  total_cost_usd: number;
}

function rangeStartDate(range: Range): string | null {
  if (range === "all") return null;
  const days =
    range === "1d" ? 0 : range === "7d" ? 7 : range === "30d" ? 30 : 365;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/// 본인 user_id 의 모든 디바이스 행 (usage_aggregates) 을 Point[] 로 합성.
/// usage_aggregates PK 에 device_id 가 포함돼 기기별 행이 분리 저장되며,
/// 여기서는 user_id 로만 필터해 전 기기 행을 가져온다 (기기당 같은 ts 의 점이
/// 여러 개일 수 있고, 토큰 합산은 ts 버킷 단위로 소비처 차트에서 수행).
/// cache 분리/시간단위/메시지수는 aggregates 에 없으므로 cache_read 에 잔여
/// (total_tokens - input - output) 를 넣어 토큰 합계만 정합. 실패 시 null →
/// 로컬 invoke fallback.
async function fetchMyAggregatedPoints(
  range: Range,
  source?: string,
): Promise<Point[] | null> {
  try {
    const { data: sess } = await supabase.auth.getSession();
    const uid = sess.session?.user.id;
    if (!uid) return null;
    let q = supabase
      .from("usage_aggregates")
      .select("date,source,total_input,total_output,total_tokens,total_cost_usd")
      .eq("user_id", uid);
    const start = rangeStartDate(range);
    if (start) q = q.gte("date", start);
    if (source) q = q.eq("source", source);
    const { data, error } = await q;
    if (error || !data) return null;
    const rows = data as MyAggregateRow[];
    return rows.map((r) => {
      const localMidnight = new Date(r.date + "T00:00:00").getTime();
      const cacheRemainder = Math.max(
        0,
        r.total_tokens - r.total_input - r.total_output,
      );
      return {
        ts: localMidnight,
        input_tokens: r.total_input,
        output_tokens: r.total_output,
        cache_read: cacheRemainder,
        cache_write: 0,
        cost_usd: r.total_cost_usd,
      };
    });
  } catch {
    return null;
  }
}

export function useTimeseries(range: Range, source?: string) {
  return useQuery({
    queryKey: ["timeseries", range, source],
    queryFn: async () => {
      if (IS_MOCK) return delay(buildMockTimeseries(range, source));
      // 로그인 시 Supabase 합산본 우선 (다중 디바이스), 실패/비로그인 시 로컬.
      // 시간별(hourly) 차트는 일(day) 단위 usage_aggregates 가 부적합해 별도 useMyHourly 사용.
      const agg = await fetchMyAggregatedPoints(range, source);
      if (agg && agg.length > 0) return agg;
      return tauriInvoke<Point[]>("get_timeseries", {
        range,
        source: source ?? null,
      });
    },
    staleTime: 30_000,
  });
}

// usage_hourly row (본인 user_id 만 RLS 로 SELECT 허용).
interface MyHourlyRow {
  hour_utc: string; // UTC 정시 버킷 ISO
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
}

/// 본인 usage_hourly 를 직접 SELECT 해 Point[] 로 반환 (시간별 DB 소스).
/// 다기기 사용자도 본인 전 기기 시간별 합계를 보게 하기 위함.
/// PK (user_id,hour_utc,source,model,device_id) 라 한 hour 에 여러 행이 올 수 있으나,
/// 소비처(Dashboard)의 aggregateByPeriod 가 hour 버킷으로 합산하므로 그대로 매핑한다.
/// enabled=시간별 뷰일 때만 true. 실패/비로그인 시 [].
export function useMyHourly(enabled: boolean) {
  return useQuery<Point[]>({
    queryKey: ["my_hourly"],
    enabled,
    queryFn: async () => {
      if (IS_MOCK) return delay(buildMockTimeseries("1d"));
      const { data: sess } = await supabase.auth.getSession();
      const uid = sess.session?.user.id;
      if (!uid) return [];
      // 최근 2일 (오늘 시간별 + 자정 경계 여유). hour_utc 는 UTC ISO.
      const since = new Date(Date.now() - 2 * 86_400_000).toISOString();
      const { data, error } = await supabase
        .from("usage_hourly")
        .select("hour_utc,input_tokens,output_tokens,cache_read,cache_write,cost_usd")
        .eq("user_id", uid)
        .gte("hour_utc", since);
      if (error || !data) return [];
      return (data as MyHourlyRow[]).map((r) => ({
        ts: Date.parse(r.hour_utc),
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cache_read: r.cache_read,
        cache_write: r.cache_write,
        cost_usd: r.cost_usd,
      }));
    },
    staleTime: 30_000,
  });
}

export function useTopMcp(range: Range) {
  return useQuery({
    queryKey: ["top_mcp", range],
    queryFn: () =>
      IS_MOCK
        ? delay(buildMockTopMcp(range))
        : tauriInvoke<McpUsage[]>("get_top_mcp", { range }),
    staleTime: 30_000,
  });
}

export function useTopPlugins(range: Range) {
  return useQuery({
    queryKey: ["top_plugins", range],
    queryFn: () =>
      IS_MOCK
        ? delay(buildMockTopPlugins(range))
        : tauriInvoke<PluginUsage[]>("get_top_plugins", { range }),
    staleTime: 30_000,
  });
}

export function useTopTools(range: Range) {
  return useQuery({
    queryKey: ["top_tools", range],
    queryFn: () =>
      IS_MOCK
        ? delay(buildMockTopTools(range))
        : tauriInvoke<ToolUsage[]>("get_top_tools", { range }),
    staleTime: 30_000,
  });
}

export function useHeatmap(days?: number) {
  return useQuery({
    queryKey: ["heatmap", days],
    queryFn: () =>
      IS_MOCK
        ? delay(buildMockHeatmap(days))
        : tauriInvoke<DayCount[]>("get_heatmap", { days: days ?? null }),
    staleTime: 60_000,
  });
}

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

export function useOAuthUsage() {
  return useQuery<OAuthUsageWithError>({
    queryKey: ["oauthUsage"],
    queryFn: async () => {
      if (IS_MOCK) return { data: null, error: null };
      try {
        const data = await tauriInvoke<OAuthUsage>("get_oauth_usage");
        return { data, error: null };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // eslint-disable-next-line no-console
        console.warn("[oauth_usage] fetch failed:", msg);
        return { data: null, error: msg };
      }
    },
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    retry: 1,
  });
}

export async function refreshOAuthUsage(): Promise<OAuthUsageWithError> {
  if (IS_MOCK) return { data: null, error: null };
  try {
    const data = await tauriInvoke<OAuthUsage>("refresh_oauth_usage");
    return { data, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { data: null, error: msg };
  }
}

// Supabase RPC `get_top_mcp_servers` 결과 row 형태
interface CompanyMcpRow {
  mcp_server: string;
  total_count: number;
}

// 사내 MCP TOP 10 — Supabase RPC 사용. 비로그인/오류/빈 결과는 mock으로 대체해
// MVP 시연 단계의 빈 화면을 방지한다. share_consent=true 유저가 1명이라도 있고
// aggregator가 한 번 돌면 실제 데이터로 자동 swap.
export function useCompanyTopMcp(rangeDays = 30) {
  return useQuery({
    queryKey: ["company_top_mcp", rangeDays],
    queryFn: async (): Promise<McpUsage[]> => {
      const { data, error } = await supabase.rpc("get_top_mcp_servers", {
        range_days: rangeDays,
      });
      if (error) {
        console.warn("[company_top_mcp] RPC error, falling back to mock:", error.message);
        return buildMockCompanyTopMcp();
      }
      const rows = (data ?? []) as CompanyMcpRow[];
      if (rows.length === 0) {
        return buildMockCompanyTopMcp();
      }
      return rows.map((r) => ({ mcp_server: r.mcp_server, count: Number(r.total_count) }));
    },
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });
}

// Supabase RPC `get_top_plugins` 결과 row 형태
interface CompanyPluginRow {
  plugin_id: string;
  total_count: number;
}

export function useCompanyTopPlugins(rangeDays = 30) {
  return useQuery({
    queryKey: ["company_top_plugins", rangeDays],
    queryFn: async (): Promise<PluginUsage[]> => {
      const { data, error } = await supabase.rpc("get_top_plugins", {
        range_days: rangeDays,
      });
      if (error) {
        console.warn("[company_top_plugins] RPC error:", error.message);
        return [];
      }
      const rows = (data ?? []) as CompanyPluginRow[];
      return rows.map((r) => ({ plugin_id: r.plugin_id, count: Number(r.total_count) }));
    },
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });
}

// Supabase RPC `get_top_users(range_days, max_rows)` 결과 row 형태
interface CompanyLeaderboardRow {
  user_id: string | null;
  display_name: string;
  avatar_url: string | null;
  total_cost: number;
  total_tokens: number;
}

export interface CompanyLeaderboardEntry {
  rank: number;
  user_id: string | null;
  display_name: string;
  avatar_url: string | null;
  total_cost: number;
  total_tokens: number;
}

export type LeaderboardRange = "today" | "week" | "month";

// RPC get_top_users 의 WHERE 절: `date >= current_date - (range_days || ' days')::interval`.
// 단순히 rolling N 일이 아니라 대시보드 카드와 같은 calendar 의미로 매핑한다.
//   today      → 0 (today 만)
//   this-week  → 오늘 요일까지 (오늘이 월요일이면 0, 화 1, 금 4, 일 6)
//                = 이번 주 월요일부터의 일수. friday cap 은 미래 일자 없으니 자동 만족.
//   this-month → 오늘 - 이번 달 1일까지의 일수 (5/11 이면 10)
function rangeToDays(range: LeaderboardRange, today: Date = new Date()): number {
  if (range === "today") return 0;
  if (range === "week") return (today.getDay() + 6) % 7; // Mon=0..Sun=6
  return today.getDate() - 1; // month-to-date
}

export function useCompanyLeaderboard(range: LeaderboardRange = "week") {
  const days = rangeToDays(range);
  return useQuery<CompanyLeaderboardEntry[], Error>({
    // days 를 key 에 포함 → 자정 지나 의미 바뀌면 (예: 주중 → 다음 주 월요일) 자동 새 fetch.
    queryKey: ["company_leaderboard", range, days],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_top_users", {
        range_days: days,
        max_rows: 50,
      });
      if (error) {
        // RPC 미존재(미적용 마이그레이션)/RLS 문제 등을 페이지에서 보여주기 위해 throw.
        throw new Error(error.message);
      }
      const rows = (data ?? []) as CompanyLeaderboardRow[];
      // 사용량 리더보드 — TOKENS 가 1차 지표. RPC 가 비용순으로 반환해도
      // 클라이언트에서 토큰 내림차순 재정렬 + rank 재부여 (rank = 토큰 순위).
      return rows
        .slice()
        .sort((a, b) => Number(b.total_tokens) - Number(a.total_tokens))
        .map((r, i) => ({
          rank: i + 1,
          user_id: r.user_id ?? null,
          display_name: r.display_name,
          avatar_url: r.avatar_url,
          total_cost: Number(r.total_cost),
          total_tokens: Number(r.total_tokens),
        }));
    },
    // 익명 토글 등 프로필 변경이 빠르게 반영돼야 하므로 staleTime은 짧게.
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: 0,
  });
}

// 리더보드 USER 행 클릭 상세 — 특정 user 의 MCP / 플러그인 TOP.
// security-definer RPC (get_user_mcp / get_user_plugins) — 다른 사람 데이터는
// RLS 로 막혀 있어 RPC 우회. 모델별 토큰은 usage_aggregates 에 model 차원이 없어 제외.

export function useUserMcp(userId: string | null, rangeDays = 30) {
  return useQuery<McpUsage[], Error>({
    queryKey: ["user_mcp", userId, rangeDays],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_user_mcp", {
        p_user: userId,
        range_days: rangeDays,
      });
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as {
        mcp_server: string;
        total_count: number;
      }[];
      return rows.map((r) => ({
        mcp_server: r.mcp_server,
        count: Number(r.total_count),
      }));
    },
    staleTime: 60_000,
    retry: 0,
  });
}

export function useUserPlugins(userId: string | null, rangeDays = 30) {
  return useQuery<PluginUsage[], Error>({
    queryKey: ["user_plugins", userId, rangeDays],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_user_plugins", {
        p_user: userId,
        range_days: rangeDays,
      });
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as {
        plugin_id: string;
        total_count: number;
      }[];
      return rows.map((r) => ({
        plugin_id: r.plugin_id,
        count: Number(r.total_count),
      }));
    },
    staleTime: 60_000,
    retry: 0,
  });
}

export interface UserToolRow {
  tool_name: string;
  count: number;
}

/// 특정 user 의 도구(tool_name) TOP — get_user_tools (security definer).
export function useUserTools(userId: string | null, rangeDays = 30) {
  return useQuery<UserToolRow[], Error>({
    queryKey: ["user_tools", userId, rangeDays],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_user_tools", {
        p_user: userId,
        range_days: rangeDays,
      });
      if (error) throw new Error(error.message);
      return ((data ?? []) as { tool_name: string; total_count: number }[]).map((r) => ({
        tool_name: r.tool_name,
        count: Number(r.total_count),
      }));
    },
    staleTime: 60_000,
    retry: 0,
  });
}

// =============================================================================
// 매니저 전용 사용량 분석 (manager+ — get_directory / get_*_users / 사원 토큰 시계열)
// =============================================================================

export interface DirectoryRow {
  user_id: string;
  display_name: string;
  email: string | null;
  role: string;
  teams: string | null;
  total_tokens: number;
  total_cost: number;
}

/// 전사 유저 디렉토리 (권한/팀/토큰/비용). manager+ 가드 RPC.
export function useDirectory(rangeDays = 30) {
  return useQuery<DirectoryRow[], Error>({
    queryKey: ["directory", rangeDays],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_directory", { p_range_days: rangeDays });
      if (error) throw new Error(error.message);
      return ((data ?? []) as DirectoryRow[]).map((r) => ({
        ...r,
        total_tokens: Number(r.total_tokens),
        total_cost: Number(r.total_cost),
      }));
    },
    staleTime: 60_000,
    retry: 0,
  });
}

export interface EntityUserRow {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  value: number;
}

/// 엔터티(MCP/플러그인) 를 쓴 사용자 + 사용량. kind 별 RPC 분기.
/// entity 가 null 이면 비활성 (모달 닫힘 상태).
export function useEntityUsers(
  kind: "mcp" | "plugin" | null,
  entity: string | null,
  rangeDays = 30,
) {
  return useQuery<EntityUserRow[], Error>({
    queryKey: ["entity_users", kind, entity, rangeDays],
    enabled: !!kind && !!entity,
    queryFn: async () => {
      if (!kind || !entity) return [];
      const rpc =
        kind === "mcp"
          ? { fn: "get_mcp_users", arg: "p_mcp_server", field: "total_count" }
          : { fn: "get_plugin_users", arg: "p_plugin_id", field: "total_count" };
      const { data, error } = await supabase.rpc(rpc.fn, {
        [rpc.arg]: entity,
        p_range_days: rangeDays,
      });
      if (error) throw new Error(error.message);
      return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
        user_id: String(r.user_id),
        display_name: String(r.display_name),
        avatar_url: (r.avatar_url as string | null) ?? null,
        value: Number(r[rpc.field] ?? 0),
      }));
    },
    staleTime: 60_000,
    retry: 0,
  });
}

export interface CompanyUsageByUserRow {
  user_id: string;
  date: string;
  total_tokens: number;
}

/// 전사 사원별 일별 토큰 (일/주/월 라인차트의 per-bucket 통계 계산용). manager+ 가드.
export function useCompanyUsageByUser(rangeDays = 365) {
  return useQuery<CompanyUsageByUserRow[], Error>({
    queryKey: ["company_usage_by_user", rangeDays],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_company_usage_by_user", {
        p_range_days: rangeDays,
      });
      if (error) throw new Error(error.message);
      return ((data ?? []) as CompanyUsageByUserRow[]).map((r) => ({
        user_id: r.user_id,
        date: r.date,
        total_tokens: Number(r.total_tokens),
      }));
    },
    staleTime: 60_000,
    retry: 0,
  });
}

export interface CompanyHourlyByUserRow {
  user_id: string;
  hour_utc: string;
  total_tokens: number;
}

/// 전사 사원별 시간별 토큰. granularity=시간별일 때만 enabled. manager+ 가드.
export function useCompanyHourlyByUser(hours = 48, enabled = true) {
  return useQuery<CompanyHourlyByUserRow[], Error>({
    queryKey: ["company_hourly_by_user", hours],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_company_hourly_by_user", {
        p_hours: hours,
      });
      if (error) throw new Error(error.message);
      return ((data ?? []) as CompanyHourlyByUserRow[]).map((r) => ({
        user_id: r.user_id,
        hour_utc: r.hour_utc,
        total_tokens: Number(r.total_tokens),
      }));
    },
    staleTime: 60_000,
    retry: 0,
  });
}

