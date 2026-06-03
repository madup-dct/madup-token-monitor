-- 0014_tool_project_usage.sql: 도구(tool_name) 별 사용량 + per-user RPC
--
-- 선행: 0001(profiles), 0011(are_team_mates), 0012(is_manager_or_above)
--
-- 목적: 유저 상세 페이지 carousel 에 "도구 사용량" 면 추가.
--       기존엔 tool_calls.tool_name 이 로컬 SQLite 에만 있고
--       Supabase 로 안 올라가 타인 상세에서 볼 수 없었음 → mcp_usage / plugin_usage 와
--       동일 패턴으로 일별 집계 테이블 + security definer RPC 추가.
--
-- 멱등: create table if not exists / drop policy if exists / create or replace function.

-- ============================================================
-- 1) 테이블
-- ============================================================
create table if not exists tool_usage (
  user_id   uuid references profiles on delete cascade,
  date      date not null,
  tool_name text not null,
  count     bigint not null default 0,
  primary key (user_id, date, tool_name)
);

-- ============================================================
-- 2) RLS — mcp_usage 와 동일 (본인 / 팀메이트(share_consent) / manager+)
-- ============================================================
alter table tool_usage enable row level security;

-- tool_usage
drop policy if exists "tool_usage: 본인 row select" on tool_usage;
create policy "tool_usage: 본인 row select"
  on tool_usage for select using (auth.uid() = user_id);

drop policy if exists "tool_usage: 본인만 삽입" on tool_usage;
create policy "tool_usage: 본인만 삽입"
  on tool_usage for insert with check (auth.uid() = user_id);

drop policy if exists "tool_usage: 본인만 수정" on tool_usage;
create policy "tool_usage: 본인만 수정"
  on tool_usage for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "tool_usage: 팀메이트 조회" on tool_usage;
create policy "tool_usage: 팀메이트 조회"
  on tool_usage for select using (
    are_team_mates(auth.uid(), user_id)
    and exists (
      select 1 from profiles p
      where p.id = tool_usage.user_id and p.share_consent = true
    )
  );

drop policy if exists "tool_usage: 매니저 이상 전체 조회" on tool_usage;
create policy "tool_usage: 매니저 이상 전체 조회"
  on tool_usage for select using (is_manager_or_above());

-- ============================================================
-- 3) RPC — get_user_tools (security definer)
-- ============================================================
-- get_user_mcp / get_user_plugins(0010) 와 동일: 사내 모니터링 도구라 임의 유저 열람 허용.
create or replace function get_user_tools(p_user uuid, range_days int default 30)
returns table (
  tool_name   text,
  total_count bigint
)
language sql security definer stable
set search_path = public as $$
  select
    tu.tool_name,
    sum(tu.count) as total_count
  from tool_usage tu
  where tu.user_id = p_user
    and tu.date >= current_date - (range_days || ' days')::interval
  group by tu.tool_name
  order by total_count desc
  limit 10;
$$;

