import { supabase } from "@/lib/supabase";
import type {
  Team,
  TeamMember,
  TeamMemberWithProfile,
  TeamAggregate,
  TeamMemberUsage,
  AppRole,
} from "@/types/models";

/// 현재 로그인 유저의 app_roles.role. 없으면 'user' 기본.
export async function fetchMyRole(): Promise<AppRole> {
  const { data: sess } = await supabase.auth.getSession();
  const uid = sess.session?.user.id;
  if (!uid) return "user";
  const { data, error } = await supabase
    .from("app_roles")
    .select("role")
    .eq("user_id", uid)
    .maybeSingle();
  if (error || !data) return "user";
  return (data.role as AppRole) ?? "user";
}

/// 현재 로그인 유저가 소속된 팀 id 목록.
export async function fetchMyTeamIds(): Promise<string[]> {
  const { data: sess } = await supabase.auth.getSession();
  const uid = sess.session?.user.id;
  if (!uid) return [];
  const { data, error } = await supabase
    .from("team_members")
    .select("team_id")
    .eq("user_id", uid);
  if (error || !data) return [];
  return data.map((r) => r.team_id as string);
}

export async function fetchMyTeams(): Promise<Team[]> {
  const { data, error } = await supabase
    .from("teams")
    .select("*")
    .order("created_at", { ascending: true });
  if (error || !data) return [];
  return data as Team[];
}

export async function fetchTeamMembers(teamId: string): Promise<TeamMemberWithProfile[]> {
  // team_members.user_id → profiles(id) FK 자동 inference 로 nested select.
  // RLS: profiles 의 "팀메이트 조회" 정책이 같은 팀 멤버의 profile 을 허용.
  const { data, error } = await supabase
    .from("team_members")
    .select(
      "team_id, user_id, role, joined_at, profile:profiles(name, email, avatar_url, slack_handle)"
    )
    .eq("team_id", teamId);
  if (error || !data) return [];
  return data as unknown as TeamMemberWithProfile[];
}

// 기존 TeamMember 단독 fetch 가 필요한 호출처 보존용 (현재 미사용).
export async function fetchTeamMembersBasic(teamId: string): Promise<TeamMember[]> {
  const { data, error } = await supabase
    .from("team_members")
    .select("*")
    .eq("team_id", teamId);
  if (error || !data) return [];
  return data as TeamMember[];
}

export async function fetchTeamAggregates(rangeDays = 30): Promise<TeamAggregate[]> {
  const { data, error } = await supabase.rpc("get_team_aggregates", {
    p_range_days: rangeDays,
  });
  if (error) throw error;
  return (data ?? []) as TeamAggregate[];
}

export async function fetchTeamMembersUsage(
  teamId: string,
  rangeDays = 30
): Promise<TeamMemberUsage[]> {
  const { data, error } = await supabase.rpc("get_team_members_usage", {
    p_team_id: teamId,
    p_range_days: rangeDays,
  });
  if (error) throw error;
  return (data ?? []) as TeamMemberUsage[];
}

export interface TeamRankRow {
  label: string;
  count: number;
}

/// 팀 멤버 합산 MCP TOP. RLS 가 가시 범위 강제 (팀메이트/manager+).
export async function fetchTeamMcp(teamId: string, rangeDays = 30): Promise<TeamRankRow[]> {
  const { data, error } = await supabase.rpc("get_team_mcp", {
    p_team_id: teamId,
    p_range_days: rangeDays,
  });
  if (error) throw error;
  return ((data ?? []) as { mcp_server: string; count: number }[]).map((r) => ({
    label: r.mcp_server,
    count: Number(r.count),
  }));
}

/// 팀 멤버 합산 플러그인 TOP.
export async function fetchTeamPlugins(teamId: string, rangeDays = 30): Promise<TeamRankRow[]> {
  const { data, error } = await supabase.rpc("get_team_plugins", {
    p_team_id: teamId,
    p_range_days: rangeDays,
  });
  if (error) throw error;
  return ((data ?? []) as { plugin_id: string; count: number }[]).map((r) => ({
    label: r.plugin_id,
    count: Number(r.count),
  }));
}

/// 팀 생성. 트리거가 호출자를 owner 로 자동 등록.
export async function createTeam(name: string, slug: string): Promise<Team> {
  const { data: sess } = await supabase.auth.getSession();
  const uid = sess.session?.user.id;
  if (!uid) throw new Error("로그인이 필요합니다");
  const { data, error } = await supabase
    .from("teams")
    .insert({ name, slug, created_by: uid })
    .select()
    .single();
  if (error) throw error;
  return data as Team;
}

/// slack_handle 또는 email 로 팀에 멤버 초대.
/// owner/admin 만 호출 가능 (RPC 내부 가드).
export async function inviteToTeam(teamId: string, identifier: string): Promise<string> {
  const { data, error } = await supabase.rpc("invite_to_team", {
    p_team_id: teamId,
    p_identifier: identifier,
  });
  if (error) throw error;
  return data as string;
}

/// 사내 유저에게 전역 role 부여. manager+ 만 호출 가능.
export async function assignAppRole(userId: string, role: AppRole): Promise<void> {
  const { error } = await supabase.rpc("assign_app_role", {
    p_user_id: userId,
    p_role: role,
  });
  if (error) throw error;
}

export interface UserDailyAggregate {
  date: string;
  source: string;
  total_input: number;
  total_output: number;
  total_tokens: number;
  total_cost_usd: number;
}

/// 특정 유저의 일별 합계 — 직접 usage_aggregates SELECT.
/// RLS 가 team-mate (share_consent=true) 또는 manager+ 만 통과.
export async function fetchUserDailyAggregates(
  userId: string,
  days: number
): Promise<UserDailyAggregate[]> {
  if (!userId || days <= 0) return [];
  const start = new Date();
  start.setDate(start.getDate() - (days - 1));
  const startISO = start.toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("usage_aggregates")
    .select("date, source, total_input, total_output, total_tokens, total_cost_usd")
    .eq("user_id", userId)
    .gte("date", startISO)
    .order("date", { ascending: true });
  if (error || !data) return [];
  return data as UserDailyAggregate[];
}

export interface UserHourlyAggregate {
  hour_utc: string;
  source: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
  request_count: number;
}

/// 특정 유저의 시간별 합계 — usage_hourly 직접 SELECT (RLS 가 가시범위 강제).
/// 최근 `hours` 시간만. hour_utc 는 UTC 정시 버킷이므로 표시 시 로컬 시각으로 변환.
export async function fetchUserHourly(
  userId: string,
  hours = 48
): Promise<UserHourlyAggregate[]> {
  if (!userId || hours <= 0) return [];
  const since = new Date(Date.now() - hours * 3600_000);
  const { data, error } = await supabase
    .from("usage_hourly")
    .select(
      "hour_utc, source, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, request_count"
    )
    .eq("user_id", userId)
    .gte("hour_utc", since.toISOString())
    .order("hour_utc", { ascending: true });
  if (error || !data) return [];
  return data as UserHourlyAggregate[];
}

export async function fetchUserProfile(userId: string) {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, slack_handle, name, email, avatar_url")
    .eq("id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

export interface ProfileLite {
  id: string;
  slack_handle: string | null;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
}

/// 사내 유저 검색 (slack_handle / email / name 부분 매치).
/// RLS 가 가시 범위를 강제 — manager+ = 전사, team_leader = 팀메이트.
export async function searchProfiles(query: string, limit = 20): Promise<ProfileLite[]> {
  // PostgREST .or() 필터 파싱을 깨는 특수문자(쉼표·괄호·LIKE 와일드카드·백슬래시) 제거.
  const q = query.trim().replace(/[,()%*\\]/g, "");
  if (!q) return [];
  const { data, error } = await supabase
    .from("profiles")
    .select("id, slack_handle, name, email, avatar_url")
    .or(`slack_handle.ilike.%${q}%,name.ilike.%${q}%,email.ilike.%${q}%`)
    .limit(limit);
  if (error || !data) return [];
  return data as ProfileLite[];
}

/// 권한별 유저 목록. RLS 가 가시 범위를 강제하므로 별도 권한 분기 불필요
/// (manager+ = 전사 전체, team_leader = 팀메이트, 그 외 = 본인+팀).
export async function fetchUsers(limit = 300): Promise<ProfileLite[]> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, slack_handle, name, email, avatar_url")
    .order("name", { ascending: true })
    .limit(limit);
  if (error || !data) return [];
  return data as ProfileLite[];
}
