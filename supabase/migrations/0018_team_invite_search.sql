-- ============================================================
-- 0018_team_invite_search — 멤버 초대 검색 자동완성 + 다중 초대 RPC
-- ============================================================
-- 배경: 팀 owner/admin (team_members.role) 이어도 전역 role 이 낮으면
-- profiles RLS 상 비팀메이트를 SELECT 할 수 없다. 따라서 초대 후보 검색은
-- security definer RPC 로 RLS 를 우회해 사내 전체 profiles 에서 부분매치한다.
-- 가시 범위 가드는 is_team_admin(p_team_id) 로 "그 팀의 owner/admin 만" 으로 좁힌다.

-- ============================================================
-- 1) RPC — search_profiles_for_invite
-- ============================================================
-- 팀 owner/admin 만 호출 가능. name / slack_handle / email 부분매치.
-- 이미 해당 팀의 멤버인 user 는 후보에서 제외.
create or replace function search_profiles_for_invite(
  p_team_id uuid,
  p_query   text,
  p_limit   int default 10
)
returns table(
  user_id     uuid,
  name        text,
  email       text,
  avatar_url  text,
  slack_handle text
)
language plpgsql stable security definer
set search_path = public as $$
begin
  if not is_team_admin(p_team_id) then
    raise exception 'forbidden: 팀 owner/admin 만 초대 후보를 검색할 수 있습니다';
  end if;

  -- 빈/너무 짧은 쿼리는 전체 profiles 덤프가 되므로 후보 없음 처리 (프론트 가드 + 방어 심층화)
  if p_query is null or length(trim(p_query)) < 2 then
    return;
  end if;

  return query
  select p.id, p.name, p.email, p.avatar_url, p.slack_handle
  from profiles p
  where (
        p.name ilike '%' || p_query || '%'
     or p.slack_handle ilike '%' || p_query || '%'
     or p.email ilike '%' || p_query || '%'
  )
  and not exists (
    select 1 from team_members tm
    where tm.team_id = p_team_id and tm.user_id = p.id
  )
  limit p_limit;
end;
$$;

-- ============================================================
-- 2) RPC — invite_members_to_team
-- ============================================================
-- 팀 owner/admin 만 호출 가능. user id 배열을 받아 team_members 에 'member' 로
-- 일괄 추가. 이미 있는 멤버는 on conflict do nothing. 새로 추가된 행 수를 반환.
create or replace function invite_members_to_team(
  p_team_id  uuid,
  p_user_ids uuid[]
)
returns int
language plpgsql security definer
set search_path = public as $$
declare
  v_user_id uuid;
  v_count   int := 0;
begin
  if not is_team_admin(p_team_id) then
    raise exception 'forbidden: 팀 owner/admin 만 멤버를 초대할 수 있습니다';
  end if;

  foreach v_user_id in array p_user_ids loop
    insert into team_members (team_id, user_id, role)
    values (p_team_id, v_user_id, 'member')
    on conflict (team_id, user_id) do nothing;
    if found then
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

grant execute on function search_profiles_for_invite(uuid, text, int) to authenticated;
grant execute on function invite_members_to_team(uuid, uuid[]) to authenticated;
