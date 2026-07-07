-- ============================================================
-- 0022_team_delete_and_transfer — 팀 삭제 / 팀장 이전 / 팀 나가기
-- ============================================================
-- teams DELETE / team_members UPDATE·DELETE RLS 정책은 0011 에 이미 있으나,
-- 비즈니스 규칙(빈 팀만 삭제 · owner 이전 원자성 · owner leave 금지 ·
-- 이전 대상 app-role 제한)을 security definer RPC 로 강제한다.
-- app_roles SELECT RLS 는 본인/manager+ 만 허용하므로, 팀장 위임 UI 게이팅용
-- 멤버 app-role 조회도 is_team_admin 가드 security definer RPC 로 제공한다.

-- 현재 호출자가 해당 팀의 owner 인지 (is_team_admin 은 admin 포함이라 별도 판정).
create or replace function is_team_owner(p_team_id uuid)
returns boolean
language sql stable security definer
set search_path = public as $$
  select exists (
    select 1 from team_members
    where team_id = p_team_id and user_id = auth.uid() and role = 'owner'
  );
$$;

-- 1) delete_team — owner 이고 팀원이 owner 본인뿐일 때만 삭제. team_members 는 CASCADE.
create or replace function delete_team(p_team_id uuid)
returns void
language plpgsql security definer
set search_path = public as $$
declare
  v_member_count int;
begin
  if not is_team_owner(p_team_id) then
    raise exception 'forbidden: 팀장만 팀을 삭제할 수 있습니다';
  end if;

  select count(*) into v_member_count from team_members where team_id = p_team_id;
  if v_member_count > 1 then
    raise exception '팀원을 모두 내보낸 뒤 삭제할 수 있습니다';
  end if;

  delete from teams where id = p_team_id;
end;
$$;

-- 2) transfer_team_owner — owner→member, 대상→owner (원자적).
-- 대상: 기존 멤버 + 본인 아님 + app-role team_leader/manager/admin.
create or replace function transfer_team_owner(p_team_id uuid, p_new_owner uuid)
returns void
language plpgsql security definer
set search_path = public as $$
declare
  v_caller uuid := auth.uid();
begin
  if not is_team_owner(p_team_id) then
    raise exception 'forbidden: 팀장만 팀장을 이전할 수 있습니다';
  end if;
  if p_new_owner = v_caller then
    raise exception '자기 자신에게는 이전할 수 없습니다';
  end if;
  if not exists (
    select 1 from team_members where team_id = p_team_id and user_id = p_new_owner
  ) then
    raise exception '대상이 팀 멤버가 아닙니다';
  end if;
  if not exists (
    select 1 from app_roles
    where user_id = p_new_owner and role in ('team_leader', 'manager', 'admin')
  ) then
    raise exception '팀장은 team_leader 이상 권한 멤버에게만 이전할 수 있습니다';
  end if;

  update team_members set role = 'member'
  where team_id = p_team_id and user_id = v_caller;
  update team_members set role = 'owner'
  where team_id = p_team_id and user_id = p_new_owner;
end;
$$;

-- 3) leave_team — 멤버 본인 탈퇴. owner 는 불가(팀장 먼저 이전).
create or replace function leave_team(p_team_id uuid)
returns void
language plpgsql security definer
set search_path = public as $$
declare
  v_caller uuid := auth.uid();
  v_role   text;
begin
  select role into v_role from team_members
  where team_id = p_team_id and user_id = v_caller;
  if v_role is null then
    raise exception '팀 멤버가 아닙니다';
  end if;
  if v_role = 'owner' then
    raise exception '팀장은 팀장을 먼저 이전한 뒤 나갈 수 있습니다';
  end if;

  delete from team_members where team_id = p_team_id and user_id = v_caller;
end;
$$;

-- 4) get_team_member_roles — 팀 owner/admin 이 멤버들의 전역 app-role 조회.
-- (app_roles SELECT RLS 우회용. 팀장 위임 대상 UI 게이팅에 사용.)
-- app_roles 행이 없는 멤버는 'user' 로 채워 반환.
create or replace function get_team_member_roles(p_team_id uuid)
returns table(user_id uuid, app_role text)
language plpgsql stable security definer
set search_path = public as $$
begin
  if not is_team_admin(p_team_id) then
    raise exception 'forbidden: 팀 owner/admin 만 조회할 수 있습니다';
  end if;
  return query
  select tm.user_id, coalesce(ar.role, 'user')::text
  from team_members tm
  left join app_roles ar on ar.user_id = tm.user_id
  where tm.team_id = p_team_id;
end;
$$;

grant execute on function is_team_owner(uuid) to authenticated;
grant execute on function delete_team(uuid) to authenticated;
grant execute on function transfer_team_owner(uuid, uuid) to authenticated;
grant execute on function leave_team(uuid) to authenticated;
grant execute on function get_team_member_roles(uuid) to authenticated;
