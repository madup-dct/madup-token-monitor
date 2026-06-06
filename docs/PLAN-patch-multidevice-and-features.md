# 플랜 — 통합 패치: 다기기 토큰 fix + 기능 3종

> 작성: 2026-06-05
> 상태: **플랜 — 구현/승인 대기.**
> 범위: (0) 다기기 토큰 합산 fix, (1) Settings 업데이트 알림+재설치+자동재시작, (2) "유저 디렉토리"→"유저 리스트", (3) 멤버 초대 검색+다중선택.
> 토큰 fix 상세: `docs/PLAN-multidevice-token-fix.md` (이 문서는 그걸 포함한 패치 전체 플랜).

## 마이그레이션 번호 배정 (충돌 해소)
- `supabase/migrations/0017_device_id.sql` — 토큰 fix (5개 테이블 device_id PK)
- `supabase/migrations/0018_team_invite_search.sql` — F3 (검색/배치초대 RPC)

> ⚠️ 두 마이그레이션 모두 production Supabase 적용은 **사용자 승인 후**. 특히 0017 의 클린 슬레이트(기존 행 삭제)는 파괴적 → 별도 확인.

---

## 0. 다기기 토큰 합산 fix — **device_id 방식 채택** (사용자: "원래 추천대로")

상세는 `docs/PLAN-multidevice-token-fix.md`. 확정된 결정:
- 방식: **device_id 차원 추가** (안 1). additive 는 watermark + 데이터 처리가 결국 필요해 미채택.
- 복구: **데이터 유지 + 본인 재sync 시 자동 정리** (2026-06-05 확정). 삭제 없음. 신버전 앱이 업로드 성공 후 `purge_my_legacy()`(본인 legacy 행만) 1회 호출, 로컬 플래그로 게이트. 전원 공백·미참여자 손실 없음. 상세 `PLAN-multidevice-token-fix.md` §6.
- device_label(hostname): **미적용** (uuid 만). frontend 노출: **없음** (Rust 내부 주입).
- reader 변경: **0건** (RPC 16개·프론트 SELECT 3곳 전부 이미 user 단위 SUM — 감사 완료).

구현 항목: `0017_device_id.sql`, `Cargo.toml`(uuid), 로컬 device_id get-or-create(`config_dir`, data_files 제외), `aggregator.rs`(5 struct + 5 on_conflict + read_* 시그니처 + sync_aggregates_now), `useUsage.ts:56-57` 주석.

---

## 1. Settings 업데이트 알림 + 재설치 + 자동 재시작

백엔드는 ~80% 준비됨(updater endpoint/pubkey/서명/Cargo 의존/플러그인 등록 ✅, `release.yml` latest.json 공급 ✅). JS 의존 + 권한 + UI 만 추가.

### 결정
- **재시작 방식: 기존 `restart_app`(`lib.rs:49-52`, `app.restart()`) 재활용** (plugin-process 추가 불필요, 의존/권한 최소화). updater 표준 `relaunch()` 가 필요하면 그때 plugin-process 도입.
- **체크 트리거**: (a) 앱 시작 시 1회(자동) + (b) Settings "앱 정보" 카드의 "업데이트 확인" 버튼(수동). `notify_on_update` 토글(`Settings.tsx:78`)이 켜져 있으면 시작 시 자동 체크 → 새 버전 있으면 배지/알림.

### 구현 항목
- `package.json`: `@tauri-apps/plugin-updater`(^2) 추가 → `pnpm install`.
- `src-tauri/capabilities/default.json`: permissions 에 `"updater:default"` 추가. (재시작은 `restart_app`/`core:default` 로 충족)
- `src/pages/Settings.tsx`:
  - `:412` SwitchRow `"새 버전 알림 (준비 중)"` → `"새 버전 알림"` + description 갱신.
  - "앱 정보(04)" 카드(`:471-559`): 업데이트 확인/다운로드·설치(재설치) 버튼 + 진행률 + 상태. `:473-499` "최신" 하드코딩 배지를 `check()` 결과로 동적화. `:500-508` "(준비 중)"/"마지막 확인" 실값으로.
  - 상태 추가(`checking/updateAvailable/downloading/progress/updateError`), 설치 완료 후 기존 재시작 모달(`:638-661`)/`restart_app` 재사용.
  - Settings 는 i18n 미사용(하드코딩) → ko.json 변경 불필요.
- 흐름: `check()` → `update.downloadAndInstall(onProgress)` → `invoke("restart_app")`.
- 검증: `pnpm build`. 실동작은 publish 된 release 필요(로컬은 호출 경로까지).

---

## 2. "유저 디렉토리" → "유저 리스트" (rename)

- **단 1곳**: `src/components/team/UserDirectory.tsx:31` 하드코딩 라벨 `유저 디렉토리` → `유저 리스트`.
- 코드 식별자(`UserDirectory`, `get_directory`, `useDirectory`, `DirectoryRow`, queryKey 등)는 **보존**. i18n 변경 불필요(이 라벨은 i18n화 안 됨). `lib/labels.ts:4` "디렉토리"는 무관(경로 의미) — 건드리지 않음.
- (선택) 인접 주석 `UserDirectory.tsx:6` 한 줄 동반 갱신.

---

## 3. 멤버 초대 검색 + 다중선택

대상: `src/components/team/TeamManageList.tsx` 의 `TeamDetail`(실사용 경로). `TeamManagePanel.tsx` 는 dead(미import) → 무시.

### 핵심 제약 (RLS)
팀 `owner/admin` 이어도 전역 role 이 `team_leader`/`user` 면 `profiles` RLS(본인+팀메이트+manager↑)상 **비팀메이트 유저를 검색 못 함**. 기존 `searchProfiles`(`teams.ts:236`, RLS 의존)로는 자동완성이 빈 결과. → **security definer 검색 RPC 필수.**

### 새 RPC (`0018_team_invite_search.sql`)
1. `search_profiles_for_invite(p_team_id uuid, p_query text, p_limit int)` — security definer + `is_team_admin(p_team_id)` 가드. `profiles` `ilike` 부분매치(name/slack_handle/email). "정하"→정하늘, "hnjung"→hnjung@madup.com. (이미 팀멤버인 사람은 제외하거나 표시)
2. `invite_members_to_team(p_team_id uuid, p_user_ids uuid[])` — security definer + `is_team_admin` 가드. 배열 loop insert `on conflict do nothing`. 반환 추가된 수/ids.

### 프론트
- `src/lib/teams.ts`: `searchProfilesForInvite(teamId, query, limit)`, `inviteMembersToTeam(teamId, userIds[])` 추가. (기존 `inviteToTeam`/`searchProfiles` 는 타 사용처 있어 유지)
- `src/components/team/TeamManageList.tsx` `TeamDetail`:
  - 초대 입력(`:262-289`)을 **자동완성 다중선택 picker** 로 교체: debounce 검색 → 드롭다운(이름+이메일/handle) → 클릭 시 선택칩 누적(다중) → "N명 초대" → `inviteMembersToTeam`. 성공 시 기존 invalidate 키 유지.
  - **하단 멤버 리스트(`:291-336`) 제거** (멤버 리더보드 `TeamDashboardPanel.tsx:94-121` 가 대체). 동반: 미사용된 `membersQ`(`:212-216`)·`fetchTeamMembers` import 정리.
  - No-Duplicate UI 규칙: picker 는 `src/components/team/MemberInvitePicker.tsx` 로 추출(드롭다운은 디자인시스템 `Select`/패턴 준수).

---

## 구현 순서 (권장)
1. **F2 rename** (가장 안전, 1줄) — 즉시.
2. **F1 updater** (frontend + capability, prod 무관) — 빌드 검증 가능.
3. **F3** — 0018 마이그레이션 작성 → 프론트 picker → 0018 prod 적용(승인).
4. **토큰 fix** — 0017 + Rust + 로컬 device_id. 0017 prod 적용 + 클린 슬레이트(파괴적, 최종 승인) → 신버전 릴리즈 동시 → Slack "각 기기 재실행" 공지.

## 검증
- `pnpm build` + `cargo build` 통과(각 단계). `pnpm tauri build` 로컬 검증은 **사용자 직접**(로컬 빌드 정책).
- 토큰 fix: 다기기 합산/단일기기 멱등/복구 후 skpark DB 대조(supabase-cli-agent).
- F3: 전역 team_leader+팀 owner 계정으로 비팀메이트 검색·다중초대 동작.
- F1: `check()` 경로 + 빌드. 실 업데이트는 publish 후.

## 미결정 / 승인 필요
1. ~~클린 슬레이트~~ → **폐기. 데이터 유지 + `purge_my_legacy`(본인 행) 자동 정리로 확정** (삭제 없음).
2. 0017/0018 prod 적용은 승인 후(저사용 시간대 + 신버전 동시 권장).
3. (F1) updater 표준 `relaunch` 도입 여부 — 기본은 `restart_app` 재활용.
4. (F3) dead 파일 `TeamManagePanel.tsx` 삭제 여부(요청 범위 밖, 언급만).
