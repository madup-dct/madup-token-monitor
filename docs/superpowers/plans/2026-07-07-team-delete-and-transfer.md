# 팀 삭제 + 팀장 이전 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 팀장(`team_members.role='owner'`)이 자신의 팀을 관리 화면에서 삭제하고, 팀장을 자격 있는 멤버에게 이전하며, 일반 멤버는 팀을 나갈 수 있게 한다.

**Architecture:** 비즈니스 규칙(빈 팀만 삭제 / owner 이전 원자성 / owner leave 금지 / 이전 대상 app-role 제한)은 신규 security-definer RPC 4개로 서버에서 강제한다. 프론트는 `src/lib/teams.ts` 래퍼로 RPC 를 호출하고, `TeamManageList`(삭제·이전·뱃지) + `MyTeamPanel`(나가기) UI 를 붙인다.

**Tech Stack:** Supabase Postgres (plpgsql RPC + RLS), React 19 + TypeScript, @tanstack/react-query, Tailwind (`mc-*` 유틸).

## Global Constraints

- 권한 판별 기준은 **`team_members.role='owner'`**. `teams.created_by` 와 `app_roles` 는 이 기능에서 변경하지 않는다.
- 모든 신규 RPC: `language plpgsql security definer` + `set search_path = public` + 내부 가드로 권한 검증 + `grant execute ... to authenticated`. 기존 마이그레이션(`0018`)과 동일 스타일.
- 팀장 이전 대상은 app-role `team_leader`/`manager`/`admin` 만 허용(app-role `user` 제외).
- owner 는 나가기 불가. owner 혼자 남은 팀은 삭제만 가능.
- 이전 후 기존 팀장 역할은 `member`.
- 커밋 메시지: Conventional Commits, 한국어 본문. Co-Authored-By 푸터.
- Supabase 마이그레이션 적용/조회는 **supabase-cli-agent 로 위임**(우회 금지). 직접 UPDATE 금지.
- 프론트 검증은 `pnpm build`(tsc+vite) 통과가 1차 게이트. 팀 기능 자동 테스트 인프라가 없으므로 UI 는 빌드+수동/playwright 로 검증(가짜 단위테스트를 만들지 않는다).

---

### Task 1: 마이그레이션 — 삭제/이전/나가기 RPC + 멤버 role 조회 RPC

**Files:**
- Create: `supabase/migrations/0022_team_delete_and_transfer.sql`

**Interfaces:**
- Produces (RPC 시그니처, 프론트가 의존):
  - `delete_team(p_team_id uuid) returns void`
  - `transfer_team_owner(p_team_id uuid, p_new_owner uuid) returns void`
  - `leave_team(p_team_id uuid) returns void`
  - `get_team_member_roles(p_team_id uuid) returns table(user_id uuid, app_role text)`
  - `is_team_owner(p_team_id uuid) returns boolean` (헬퍼)

- [ ] **Step 1: 마이그레이션 파일 작성**

Create `supabase/migrations/0022_team_delete_and_transfer.sql`:

```sql
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
```

- [ ] **Step 2: supabase-cli-agent 로 dry-run 시나리오 검증 (적용 전)**

supabase-cli-agent 에 위임. 하나의 `BEGIN … ROLLBACK` 트랜잭션 안에서(실데이터 변경 없이) 마이그레이션 SQL 을 실행해 함수를 만든 뒤, 아래를 확인 요청:
- 임의 팀 골라 `set local role` / `request.jwt.claim.sub` 없이도 함수 정의가 문법 오류 없이 생성되는지 (create 성공).
- 로직 리뷰: `delete_team` 가 `v_member_count > 1` 에서 예외, 1 에서 delete; `transfer_team_owner` 가드 4개; `leave_team` owner 예외; `get_team_member_roles` is_team_admin 가드.
- **값·시크릿 출력 금지.** 결과는 성공/실패 + 문법 검증만.

Expected: 4개 RPC + 헬퍼가 문법 오류 없이 생성됨(ROLLBACK 로 정리).

- [ ] **Step 3: supabase-cli-agent 로 실제 적용**

dry-run 통과 후 supabase-cli-agent 로 `0022_team_delete_and_transfer.sql` 을 실제 DB 에 적용(psql 또는 migration 경로). 적용 후 `\df delete_team transfer_team_owner leave_team get_team_member_roles is_team_owner` 로 4+1 함수 존재 확인.

Expected: 함수 5개 존재.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0022_team_delete_and_transfer.sql
git commit -m "feat(team): 팀 삭제·팀장 이전·나가기 RPC 추가 (0022)

- delete_team: owner + 빈 팀(멤버 1명)만 삭제
- transfer_team_owner: owner→member/대상→owner 원자 교체, 대상 app-role team_leader+ 제한
- leave_team: 멤버 탈퇴, owner 는 이전 먼저
- get_team_member_roles: 위임 UI 게이팅용 멤버 app-role 조회(is_team_admin 가드)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: 데이터 계층 — `src/lib/teams.ts` 래퍼 추가

**Files:**
- Modify: `src/lib/teams.ts` (파일 끝에 추가)

**Interfaces:**
- Consumes: Task 1 의 RPC (`delete_team`, `transfer_team_owner`, `leave_team`, `get_team_member_roles`).
- Produces (Task 3·4 가 의존):
  - `deleteTeam(teamId: string): Promise<void>`
  - `transferTeamOwner(teamId: string, newOwnerId: string): Promise<void>`
  - `leaveTeam(teamId: string): Promise<void>`
  - `fetchTeamMemberRoles(teamId: string): Promise<Record<string, AppRole>>` (user_id → app_role)
  - `fetchMyMemberships(): Promise<{ team_id: string; role: TeamMember["role"] }[]>`

- [ ] **Step 1: 함수 5개 추가**

`src/lib/teams.ts` 파일 **맨 끝**에 append:

```typescript
/// 팀 삭제 — owner 이고 팀원이 본인뿐일 때만 성공(RPC 가 규칙 강제). 그 외 예외 throw.
export async function deleteTeam(teamId: string): Promise<void> {
  const { error } = await supabase.rpc("delete_team", { p_team_id: teamId });
  if (error) throw error;
}

/// 팀장 이전 — owner→member, 대상→owner. 대상은 app-role team_leader+ 인 기존 멤버만(RPC 강제).
export async function transferTeamOwner(teamId: string, newOwnerId: string): Promise<void> {
  const { error } = await supabase.rpc("transfer_team_owner", {
    p_team_id: teamId,
    p_new_owner: newOwnerId,
  });
  if (error) throw error;
}

/// 팀 나가기 — 일반 멤버 본인 탈퇴. owner 는 RPC 가 거부(팀장 먼저 이전).
export async function leaveTeam(teamId: string): Promise<void> {
  const { error } = await supabase.rpc("leave_team", { p_team_id: teamId });
  if (error) throw error;
}

/// 팀 멤버들의 전역 app-role 조회 (팀장 위임 대상 게이팅용). owner/admin 만 호출 가능.
/// 반환: user_id → app_role 맵. RPC 실패(비관리자 등) 시 빈 맵.
export async function fetchTeamMemberRoles(teamId: string): Promise<Record<string, AppRole>> {
  const { data, error } = await supabase.rpc("get_team_member_roles", { p_team_id: teamId });
  if (error || !data) return {};
  const map: Record<string, AppRole> = {};
  for (const r of data as { user_id: string; app_role: string }[]) {
    map[r.user_id] = (r.app_role as AppRole) ?? "user";
  }
  return map;
}

/// 현재 로그인 유저의 (team_id, role) 목록 — owner 뱃지 / 나가기 게이팅용.
export async function fetchMyMemberships(): Promise<
  { team_id: string; role: TeamMember["role"] }[]
> {
  const { data: sess } = await supabase.auth.getSession();
  const uid = sess.session?.user.id;
  if (!uid) return [];
  const { data, error } = await supabase
    .from("team_members")
    .select("team_id, role")
    .eq("user_id", uid);
  if (error || !data) return [];
  return data as { team_id: string; role: TeamMember["role"] }[];
}
```

- [ ] **Step 2: 빌드로 타입 검증**

Run: `pnpm build`
Expected: PASS (tsc 에러 없음). `TeamMember`, `AppRole` 는 파일 상단에서 이미 import 됨.

- [ ] **Step 3: Commit**

```bash
git add src/lib/teams.ts
git commit -m "feat(team): 팀 삭제·이전·나가기·멤버role 조회 데이터 계층 추가

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `TeamManageList.tsx` — 삭제 버튼 + 팀장 위임 + owner 뱃지

**Files:**
- Modify: `src/components/team/TeamManageList.tsx`

**Interfaces:**
- Consumes: `deleteTeam`, `transferTeamOwner`, `fetchTeamMemberRoles`, `fetchMyMemberships` (Task 2).

#### 3A. import 확장

- [ ] **Step 1: import 갱신**

`src/components/team/TeamManageList.tsx:4-11` 의 `@/lib/teams` import 블록에 함수 추가:

```typescript
import {
  createTeam,
  deleteTeam,
  fetchMyMemberships,
  fetchMyTeams,
  fetchTeamAggregates,
  fetchTeamMemberRoles,
  fetchTeamMembers,
  inviteMembersToTeam,
  removeTeamMember,
  transferTeamOwner,
} from "@/lib/teams";
```

`@/types/models` import 에 `AppRole` 추가:

```typescript
import type { AppRole, Team, TeamMemberWithProfile } from "@/types/models";
```

#### 3B. TeamListView — owner "팀장" 뱃지

- [ ] **Step 2: 내 멤버십 쿼리 + 소유 팀 집합**

`TeamListView` 내부, `teamsQ` 선언 다음(파일 `:59` 뒤)에 추가:

```typescript
  const membershipsQ = useQuery({
    queryKey: ["my_memberships", user?.id ?? "anon"],
    queryFn: fetchMyMemberships,
    enabled: !!user,
  });
  const ownedTeamIds = useMemo(
    () => new Set((membershipsQ.data ?? []).filter((m) => m.role === "owner").map((m) => m.team_id)),
    [membershipsQ.data],
  );
```

- [ ] **Step 3: 팀 이름 셀에 뱃지 렌더**

`:177-179` 의 팀 이름 `<td>` 를 다음으로 교체:

```tsx
                    <td className="px-5 py-3 text-[12.5px] text-text-primary font-semibold">
                      <span className="inline-flex items-center gap-1.5">
                        {t.name}
                        {ownedTeamIds.has(t.id) ? (
                          <span className="px-1.5 py-0.5 rounded bg-azure-bright/15 text-azure text-[9.5px] font-bold tracking-[0.06em] uppercase">
                            팀장
                          </span>
                        ) : null}
                      </span>
                    </td>
```

- [ ] **Step 4: 빌드**

Run: `pnpm build`
Expected: PASS.

#### 3C. TeamDetail — 팀장 위임 액션

- [ ] **Step 5: owner 판별 + 멤버 app-role 쿼리 + 이전 mutation**

`TeamDetail` 내부 `canManage` 선언(`:231`) 다음에 추가:

```typescript
  const isOwner = myTeamRole === "owner";
  const memberRolesQ = useQuery({
    queryKey: ["team_member_roles", teamId],
    queryFn: () => fetchTeamMemberRoles(teamId),
    enabled: !!teamId && isOwner,
  });
  const memberRoles = memberRolesQ.data ?? {};
  const [transferId, setTransferId] = useState<string | null>(null);

  const transferMut = useMutation({
    mutationFn: (userId: string) => transferTeamOwner(teamId, userId),
    onSuccess: () => {
      setTransferId(null);
      setError(null);
      setNotice("팀장을 이전했습니다");
      qc.invalidateQueries({ queryKey: ["team_members", teamId] });
      qc.invalidateQueries({ queryKey: ["team_member_roles", teamId] });
      qc.invalidateQueries({ queryKey: ["my_memberships"] });
      qc.invalidateQueries({ queryKey: ["my_teams"] });
    },
    onError: (e) => {
      setNotice(null);
      setError(e instanceof Error ? e.message : String(e));
    },
  });
```

- [ ] **Step 6: 멤버 행에 "팀장 위임" 액션 추가**

`:331` 의 `removable` 계산 아래에 자격 판별 추가하고, `:357-391` 의 액션 영역을 확장한다. `removable` 다음 줄에:

```typescript
                  const transferable =
                    isOwner &&
                    m.role !== "owner" &&
                    m.user_id !== user?.id &&
                    ["team_leader", "manager", "admin"].includes(memberRoles[m.user_id] ?? "user");
```

그리고 액션 영역(`{removable ? ( … ) : ( <span className="w-7 shrink-0" /> )}` 블록) 을 아래로 교체 — 위임 확인 UI 를 강퇴 앞에 배치:

```tsx
                      {transferable ? (
                        transferId === m.user_id ? (
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              disabled={transferMut.isPending}
                              onClick={() => transferMut.mutate(m.user_id)}
                              className="px-2.5 py-1 rounded-md bg-azure-bright/15 text-azure text-[11px] font-semibold disabled:opacity-50"
                            >
                              팀장 위임
                            </button>
                            <button
                              type="button"
                              onClick={() => setTransferId(null)}
                              className="px-2.5 py-1 rounded-md bg-surface-2 text-text-secondary text-[11px] font-semibold"
                            >
                              취소
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setTransferId(m.user_id)}
                            title="이 멤버를 팀장으로 위임"
                            className="px-2 py-1 rounded-md text-[11px] font-semibold text-text-tertiary hover:text-azure shrink-0"
                          >
                            팀장 위임
                          </button>
                        )
                      ) : null}
                      {removable ? (
                        confirmingId === m.user_id ? (
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              disabled={removeMut.isPending}
                              onClick={() => removeMut.mutate(m.user_id)}
                              className="px-2.5 py-1 rounded-md bg-rose-500/15 text-rose-300 text-[11px] font-semibold disabled:opacity-50"
                            >
                              제거
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmingId(null)}
                              className="px-2.5 py-1 rounded-md bg-surface-2 text-text-secondary text-[11px] font-semibold"
                            >
                              취소
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmingId(m.user_id)}
                            aria-label={`${name} 제거`}
                            title="팀에서 제거"
                            className="mc-icon-btn shrink-0 text-text-tertiary hover:text-rose-300"
                          >
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                              <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
                            </svg>
                          </button>
                        )
                      ) : (
                        <span className="w-7 shrink-0" />
                      )}
```

- [ ] **Step 7: 빌드**

Run: `pnpm build`
Expected: PASS.

#### 3D. TeamDetail — 팀 삭제 (danger zone)

- [ ] **Step 8: 삭제 mutation + 멤버 수 계산**

Step 5 블록 다음에 추가:

```typescript
  const memberCount = (membersQ.data ?? []).length;
  const canDelete = isOwner && memberCount <= 1;
  const [confirmDelete, setConfirmDelete] = useState(false);

  const deleteMut = useMutation({
    mutationFn: () => deleteTeam(teamId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["my_teams"] });
      qc.invalidateQueries({ queryKey: ["my_memberships"] });
      qc.invalidateQueries({ queryKey: ["team_aggregates"] });
      onBack();
    },
    onError: (e) => {
      setConfirmDelete(false);
      setNotice(null);
      setError(e instanceof Error ? e.message : String(e));
    },
  });
```

- [ ] **Step 9: 삭제 섹션 렌더 (owner 전용)**

`<TeamDashboardPanel teamId={teamId} />`(파일 `:401`) **앞**에 삽입:

```tsx
      {/* 팀 삭제 — owner 전용 danger zone. 팀원이 남아 있으면 경고 + 비활성. */}
      {isOwner ? (
        <div className="mc-card p-4 border border-rose-500/20">
          <div className="text-[11px] font-bold tracking-[0.12em] uppercase text-rose-300/80 mb-2">
            위험 구역
          </div>
          {memberCount > 1 ? (
            <p className="text-[12px] text-text-tertiary mb-3">
              팀원 {memberCount - 1}명을 모두 내보낸 뒤에 팀을 삭제할 수 있습니다.
            </p>
          ) : (
            <p className="text-[12px] text-text-tertiary mb-3">
              이 팀을 삭제하면 되돌릴 수 없습니다.
            </p>
          )}
          {confirmDelete && canDelete ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={deleteMut.isPending}
                onClick={() => deleteMut.mutate()}
                className="px-3 py-1.5 rounded-md bg-rose-500/20 text-rose-200 text-[12px] font-semibold disabled:opacity-50"
              >
                {deleteMut.isPending ? "삭제 중…" : "정말 삭제"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="px-3 py-1.5 rounded-md bg-surface-2 text-text-secondary text-[12px] font-semibold"
              >
                취소
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={!canDelete}
              onClick={() => setConfirmDelete(true)}
              className="px-3 py-1.5 rounded-md bg-rose-500/15 text-rose-300 text-[12px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
            >
              팀 삭제
            </button>
          )}
        </div>
      ) : null}
```

- [ ] **Step 10: 빌드**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/components/team/TeamManageList.tsx
git commit -m "feat(team): 팀 상세에 삭제 버튼·팀장 위임·팀장 뱃지 추가

- owner 전용 팀 삭제(팀원 남으면 경고+비활성)
- 멤버 행 팀장 위임(대상 app-role team_leader+ 게이팅)
- 내 팀 목록에 owner '팀장' 뱃지

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `MyTeamPanel.tsx` — 팀 나가기 버튼

**Files:**
- Modify: `src/components/team/MyTeamPanel.tsx`

**Interfaces:**
- Consumes: `leaveTeam`, `fetchMyMemberships` (Task 2).

- [ ] **Step 1: import 추가**

`:6-13` 의 `@/lib/teams` import 에 `leaveTeam`, `fetchMyMemberships` 추가:

```typescript
import {
  fetchMyMemberships,
  fetchMyTeams,
  fetchTeamAggregates,
  fetchTeamMcp,
  fetchTeamMembersUsage,
  fetchTeamPlugins,
  fetchTeamTopModels,
  leaveTeam,
} from "@/lib/teams";
```

`react-query` import 에 `useMutation` 추가 (`:2`):

```typescript
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
```

- [ ] **Step 2: 내 멤버십 쿼리 + 나가기 mutation + 상태**

`teamsQ` 선언(`:88`) 다음에 추가:

```typescript
  const membershipsQ = useQuery({
    queryKey: ["my_memberships", user?.id ?? "anon"],
    queryFn: fetchMyMemberships,
    enabled: !!user,
  });
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const leaveMut = useMutation({
    mutationFn: (teamId: string) => leaveTeam(teamId),
    onSuccess: () => {
      setConfirmLeave(false);
      setLeaveError(null);
      qc.invalidateQueries({ queryKey: ["my_teams"] });
      qc.invalidateQueries({ queryKey: ["my_memberships"] });
      qc.invalidateQueries({ queryKey: ["team_aggregates"] });
    },
    onError: (e) => setLeaveError(e instanceof Error ? e.message : String(e)),
  });
```

- [ ] **Step 3: 선택 팀에 대한 내 역할 파생**

`selectedTeam` 선언(`:182`) 다음에 추가:

```typescript
  const myRoleInSelected =
    (membershipsQ.data ?? []).find((m) => m.team_id === selectedTeamId)?.role ?? null;
  const canLeaveSelected = myRoleInSelected !== null && myRoleInSelected !== "owner";
```

- [ ] **Step 4: content head 에 나가기 버튼 배치**

`:495-514` 의 새로고침 `<button>` **다음**(같은 `flex gap-3` 컨테이너 내부, 닫는 `</button>` 뒤)에 추가:

```tsx
          {canLeaveSelected ? (
            confirmLeave ? (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={leaveMut.isPending}
                  onClick={() => selectedTeamId && leaveMut.mutate(selectedTeamId)}
                  className="px-3 py-1.5 rounded-md bg-rose-500/20 text-rose-200 text-[12px] font-semibold disabled:opacity-50"
                >
                  {leaveMut.isPending ? "나가는 중…" : "정말 나가기"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmLeave(false)}
                  className="px-3 py-1.5 rounded-md bg-surface-2 text-text-secondary text-[12px] font-semibold"
                >
                  취소
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmLeave(true)}
                className="px-3 py-1.5 rounded-md bg-surface-2 text-text-tertiary hover:text-rose-300 text-[12px] font-semibold"
              >
                팀 나가기
              </button>
            )
          ) : null}
```

- [ ] **Step 5: 나가기 에러 표시**

`content head` 컨테이너(`:469` 의 `<div className="flex items-center justify-between …">`) 닫힘 **다음 줄**, PrismCarousel 앞에 추가:

```tsx
      {leaveError ? (
        <div className="text-[12px] text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-md px-3 py-2">
          {leaveError}
        </div>
      ) : null}
```

- [ ] **Step 6: 빌드**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/team/MyTeamPanel.tsx
git commit -m "feat(team): 내 팀 대시보드에 '팀 나가기' 버튼 추가 (owner 제외)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: 통합 검증

**Files:** (없음 — 검증만)

- [ ] **Step 1: 전체 빌드**

Run: `pnpm build`
Expected: PASS (tsc + vite 번들 성공).

- [ ] **Step 2: 수동/Playwright 스모크 (webapp-testing)**

`pnpm tauri dev` 또는 `pnpm dev` 로 앱을 띄우고 team_leader 계정으로:
- 팀 관리 → 내가 owner 인 팀 상세: "팀장" 뱃지, 위험구역 노출 확인.
- 팀원이 있는 팀: 삭제 버튼 비활성 + "N명 내보낸 뒤" 경고.
- 멤버 전원 강퇴 후: 삭제 버튼 활성 → 삭제 → 목록 복귀 + 팀 사라짐.
- app-role team_leader+ 멤버 행에만 "팀장 위임" 노출, 위임 후 본인 관리 UI 사라짐.
- (member 계정) 내 팀 대시보드에서 "팀 나가기" → 나간 뒤 팀 사라짐. owner 계정엔 나가기 버튼 없음.

Expected: 위 흐름 정상. 실패 시 systematic-debugging.

- [ ] **Step 3: 최종 상태 보고**

빌드 결과 + 마이그레이션 적용 여부 + 수동 검증 결과를 사용자에게 보고. 앱 릴리즈(버전 bump + `scripts/release.sh`)는 사용자 몫(범위 밖).

---

## 참고: 무효화 키 맵

| 액션 | invalidate |
|---|---|
| 팀 삭제 | `["my_teams"]`, `["my_memberships"]`, `["team_aggregates"]` + `onBack()` |
| 팀장 이전 | `["team_members", teamId]`, `["team_member_roles", teamId]`, `["my_memberships"]`, `["my_teams"]` |
| 팀 나가기 | `["my_teams"]`, `["my_memberships"]`, `["team_aggregates"]` |
