# 팀 삭제 + 팀장 이전 기능 — 설계 문서

> 작성: 2026-07-07 · 상태: 검토 대기

## 1. 목표

팀 개설자(팀장)가 자신이 만든 팀을 관리 화면에서 **삭제**하고, 필요 시 **팀장을 다른
멤버에게 이전**할 수 있게 한다. 부수적으로, 팀장은 owner인 채로는 팀을 떠날 수 없고
(팀이 owner 없이 남는 것 방지) 팀장을 이전해 일반 멤버가 된 뒤에만 나갈 수 있다.

원 요구사항:
1. 팀 관리 > 내 팀 목록 > 팀 상세페이지 내에 팀 **[삭제]** 버튼 추가
2. 개설자(=팀장) 제외 모든 팀원을 내보내야 삭제 가능
3. 개설자 외 팀원이 있으면 삭제 시 경고 메시지
4. 팀장 옮기기(이전) 기능
5. (추가 확인) 팀장은 이전 후 일반 멤버일 때만 나가기 가능

## 2. 확정된 설계 결정

| 항목 | 결정 | 근거 |
|---|---|---|
| 권한 기준 | **`team_members.role='owner'`** 로 통합. `teams.created_by` 는 기록용으로 불변 | 현행 RLS·트리거가 모두 owner 기준. created_by 는 권한에 미사용 |
| 팀장 이전 후 기존 팀장 | `owner → member` 강등 | 단순·직관. 필요 시 새 팀장이 admin 재승격 |
| 팀당 owner 수 | 항상 정확히 1명 | 이전은 원자적 교체로 불변식 유지 |
| 작업 범위 | 프론트 코드 + 마이그레이션 **적용**까지. 앱 릴리즈(버전 bump + release.sh)는 사용자 | 기존 로컬 릴리즈 관행 |

## 3. 백엔드 — 신규 마이그레이션 `supabase/migrations/0022_team_delete_and_transfer.sql`

모두 `security definer` + `set search_path = public` + 내부 가드로 권한 검증. (security
definer 라 RLS 를 우회하므로 함수 내부 가드가 유일한 방어선이 되도록 작성.)

### 3.1 `delete_team(p_team_id uuid) returns void`
- 가드 1: 호출자(`auth.uid()`)가 해당 팀 owner 인가? 아니면 예외.
- 가드 2: 팀 멤버 수가 **1(=owner 본인)뿐**인가? 아니면 예외
  (메시지: `팀원을 모두 내보낸 뒤 삭제할 수 있습니다`). → 요구사항 2 를 서버에서 강제.
- 통과 시 `delete from teams where id = p_team_id` (team_members 는 `ON DELETE CASCADE`).

### 3.2 `transfer_team_owner(p_team_id uuid, p_new_owner uuid) returns void`
- 가드 1: 호출자가 현재 owner 인가?
- 가드 2: `p_new_owner` 가 그 팀의 기존 멤버이고 호출자 본인이 아닌가? 아니면 예외.
- 가드 3: `p_new_owner` 의 **전역 권한(`app_roles.role`)이 `team_leader`/`manager`/`admin`**
  중 하나인가? 아니면 예외(메시지: `팀장은 team_leader 이상 권한 멤버에게만 이전할 수 있습니다`).
  → app-role `user` 인 멤버는 owner 가 돼도 `/team/manage` 접근 불가하므로 대상에서 제외.
  (판정: `exists(select 1 from app_roles where user_id = p_new_owner and role in
  ('team_leader','manager','admin'))`.)
- 원자적 처리(단일 트랜잭션):
  - 호출자 row `role → 'member'`
  - `p_new_owner` row `role → 'owner'`
- `teams.created_by` 는 변경하지 않음. `app_roles` 도 변경하지 않음(팀 내 role 만 교체).

### 3.3 `leave_team(p_team_id uuid) returns void`
- 가드: 호출자가 그 팀의 멤버이고 **owner 가 아닌가?** owner 면 예외
  (메시지: `팀장은 팀장을 먼저 이전한 뒤 나갈 수 있습니다`). → 요구사항 5 서버 강제.
- 통과 시 호출자의 team_members row 삭제.

> 기존 RLS DELETE(owner) / UPDATE(is_team_admin) 정책은 방어선으로 유지. 신규 RPC 가
> 비즈니스 규칙(빈 팀만 삭제 / owner 이전 원자성 / owner leave 금지)을 담당.

## 4. 데이터 계층 — `src/lib/teams.ts`

- `deleteTeam(teamId)` → `supabase.rpc('delete_team', { p_team_id })`
- `transferTeamOwner(teamId, newOwnerId)` → `rpc('transfer_team_owner', { p_team_id, p_new_owner })`
- `leaveTeam(teamId)` → `rpc('leave_team', { p_team_id })`
- **멤버 조회 확장**: 팀장 위임 대상 제한(§3.2 가드 3)을 UI 에서 반영하려면 각 멤버의
  전역 권한이 필요. `fetchTeamMembers` 결과에 `app_role`(`app_roles.role`, 없으면 `'user'`)을
  포함. PostgREST 임베드(`app_role:app_roles(role)`) 또는 별도 조회 후 머지 —
  구현 단계에서 FK 임베드 가능 여부 확인해 택. `TeamMemberWithProfile` 타입에 `app_role` 추가.

에러는 Supabase error 를 그대로 throw → 호출부에서 사용자 메시지로 표시.

## 5. 프론트 UI

### 5.1 팀 삭제 + 팀장 이전 — `src/components/team/TeamManageList.tsx` (`TeamDetail` 드릴다운)
현재 이 화면은 owner/admin 이 초대·강퇴하는 곳. owner 일 때만 아래 추가:

- **팀장 이전**: 멤버 목록의 비-owner 행에, 기존 강퇴 버튼 옆 "팀장 위임" 액션.
  2단계 확인 → `transferTeamOwner`. 성공 시 본인이 member 가 되어 관리 UI(강퇴/삭제/이전)가 사라짐.
  - **대상 제한**: app-role 이 `team_leader`/`manager`/`admin` 인 멤버에게만 "팀장 위임"
    노출(app-role `user` 는 숨김). → 각 멤버의 app-role 이 목록에 필요하므로
    **멤버 조회를 `app_roles.role` 포함으로 확장**(§4 참조). RPC 가드 3 과 이중 방어.
- **팀 삭제**: 상세 하단 danger 버튼.
  - owner 외 팀원이 남아 있으면 → **경고 문구**(요구사항 3, 예: "팀원 N명을 먼저
    내보낸 뒤 삭제할 수 있습니다") + 버튼 비활성.
  - owner 혼자면 → 2단계 확인("되돌릴 수 없습니다") → `deleteTeam` → 목록으로 복귀
    (`?team=` 해제) + `["my_teams", uid]` invalidate.
- **`TeamListView` 목록에서 내가 owner 인 팀에 작은 "팀장" 뱃지**(확정) → "내가 만든 팀" 식별 보조.

invalidate: `["team_members", teamId]`, `["my_teams", uid]`.

### 5.2 팀 나가기 (member) — ⚠️ 열린 항목 (배치 확인 필요)
`leave_team` RPC 는 owner-leave 를 서버에서 막는다. 하지만 "팀 나가기" **버튼**의 배치는
결정 필요:
- **문제**: 삭제·이전이 놓이는 `TeamManageList`(=`/team/manage`)는 **team_leader 이상만
  접근**(`TeamManage.tsx:15`). 일반 member(app-role `user`)는 이 화면에 못 온다.
  일반 멤버가 자기 팀을 보는 곳은 `/team`(`MyTeamPanel`, 전원 접근).
- **후보**:
  - (A) `MyTeamPanel` 에 소속 팀별 "나가기" 버튼 (일반 멤버가 실제로 닿는 곳).
  - (B) `TeamDetail` 에만 두기 (team_leader+ 인 멤버만 나갈 수 있음 — 커버리지 좁음).
  - (C) 이번엔 버튼 없이 `leave_team` RPC 규칙만.
- **확정: (A)** — `MyTeamPanel` 에서 사용자가 소속된 팀별로 "나가기" 액션을 노출(owner 인
  팀은 제외/숨김). 대시보드 레이아웃에 맞춰 팀 헤더/행 옆 subtle 한 버튼으로 배치.

## 6. 엣지 케이스

- owner 가 팀원 있는 채 삭제 시도 → RPC 예외 → 클라 경고(요구사항 3) + 버튼 사전 비활성.
- owner 는 나가기(`leave_team`) 자체가 불가 → 팀이 owner 없이 비는 것을 원천 차단.
  UI 상 owner 에겐 "나가기" 버튼을 표시하지 않는다(나가기는 비-owner 멤버 전용).
- **owner 혼자인 팀**: 나가기 없음 + 팀장 위임 대상 없음(숨김) → 화면에 남는 유효 액션은
  **팀 삭제(활성)** 하나. 즉 "혼자 남은 owner 는 나갈 수 없고 삭제로만 팀을 정리".
- 이전 대상이 비멤버/본인 → RPC 예외.
- 이전 대상 app-role 이 `user` → UI 에서 위임 액션 숨김 + RPC 가드 3 예외(이중 방어).
- 팀에 자격(team_leader+) 멤버가 없으면 → 위임 대상 없음 → 팀장 위임 불가(삭제/유지만).
- 이전 성공 직후 본인 권한 하락 → `["my_teams"]`/멤버 목록 invalidate 로 UI 즉시 반영.

## 7. 검증 계획

- **프론트**: `pnpm build`(tsc 타입체크) 통과. 팀 관련 기존 자동 테스트 없음 → 타입/빌드 +
  로직 리뷰로 검증.
- **DB RPC**: supabase-cli-agent 로 실제 적용 **전** `BEGIN … ROLLBACK` 트랜잭션 안에서
  시나리오 dry-run:
  - 비-owner 가 delete_team → 거부
  - 팀원 남은 상태 delete_team → 거부
  - owner 혼자 delete_team → 성공(롤백)
  - transfer 후 role 이 정확히 교체되는지
  - owner leave_team → 거부 / member leave_team → 성공(롤백)
- 적용은 dry-run 통과 후 supabase-cli-agent 로 진행(우회 금지).

## 8. 범위 밖 (YAGNI)

- admin 승격/강등 일반 UI (팀장 위임에 필요한 owner↔member 만).
- 팀 이름/슬러그 편집.
- 삭제 시 데이터 아카이빙 — 하드 삭제(CASCADE)만.

## 9. 결정 완료 (2026-07-07 확정)

1. "팀 나가기" 버튼 배치 → **(A) `MyTeamPanel`**.
2. 이전 후 기존 팀장 역할 → **`member`**.
3. `TeamListView` owner "팀장" 뱃지 → **추가**.
4. 팀장 이전 대상 → app-role **`team_leader`/`manager`/`admin`** 로 제한.
5. owner 혼자 → 나가기 불가, **삭제만** 가능.
