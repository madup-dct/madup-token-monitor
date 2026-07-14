-- 0024_claude_limits_team_scope.sql: 계정 한도 열람을 팀 단위로 스코프
--
-- 배경: get_claude_account_limits() (0023) 는 로그인한 모든 유저에게 전체 계정을
--   반환했다. 요구사항(2026-07-14): 일반 유저는 같은 팀 소속 이메일의 계정만,
--   team_leader/manager/admin 은 전체를 열람.
--
-- 권한 매핑 (기존 헬퍼 재사용):
--   is_team_leader_or_above() = app_roles.role in (team_leader, manager, admin) → 전체
--   그 외(user) = 같은 팀(team_members 공유) 소속 계정 + 본인 계정만
--
-- security definer 유지 — 함수 안에서 team_members/app_roles 를 RLS 우회로 조인하고,
-- 가시성은 아래 WHERE 로 명시적으로 건다. 반환 컬럼·grant 불변 (프론트 무변경).

create or replace function get_claude_account_limits()
returns table (
  account_uuid uuid,
  account_email text,
  owner_email text,
  owner_name text,
  windows jsonb,
  fetched_at timestamptz,
  updated_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select
    s.account_uuid,
    s.account_email,
    coalesce(o.owner_email, s.account_email) as owner_email,
    p.name as owner_name,
    s.windows,
    s.fetched_at,
    s.updated_at
  from claude_limit_snapshots s
  left join claude_owner o on o.account_email = s.account_email
  -- profiles.email 은 unique 제약이 없다 — fan-out 방지 lateral limit 1
  -- (가장 오래된 프로필 우선, 결정적). 팀 스코프 판정에 쓸 owner 프로필 id 도 함께.
  left join lateral (
    select pr.id, pr.name
    from profiles pr
    where pr.email = coalesce(o.owner_email, s.account_email)
    order by pr.created_at asc, pr.id asc
    limit 1
  ) p on true
  where
    -- team_leader/manager/admin 은 전체 열람.
    is_team_leader_or_above()
    -- 내가 올린 계정은 항상 열람 — 이메일이 회사 프로필과 달라(개인 이메일 로그인 등)
    -- owner 프로필 매칭이 안 돼도 본인 계정이 사라지지 않게. uploaded_by 는 최종 업로더.
    or s.uploaded_by = auth.uid()
    -- owner 프로필이 회사 프로필과 매칭되고 그게 나일 때(중복 방어).
    or p.id = auth.uid()
    -- 일반 유저: owner 가 나와 팀을 공유하는 경우만 (0011 공통 헬퍼 재사용).
    or are_team_mates(auth.uid(), p.id)
$$;

revoke all on function get_claude_account_limits() from public;
grant execute on function get_claude_account_limits() to authenticated;
