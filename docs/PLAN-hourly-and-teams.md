# 플랜 — 시간별 측정 + 팀/권한 추가 (Supabase 유지)

> 작성: 2026-05-22 · 갱신: 2026-05-27
> 상태:
>   - 시간별 집계: **마이그레이션 SQL 작성 (0011)** — 적용 대기 (Studio).
>   - 팀/권한: **마이그레이션 0011/0012 작성 + 클라이언트 권한 분기 구현 완료** — 빌드/배포 대기.
> 후속 플랜: `.omc/plans/role-based-insights.md` (권한 4단계 + 권한별 페이지 분기).
> 다른 세션이 이 문서만 보고도 그대로 이어받을 수 있도록 작성됨.

## 0. 배경 (왜 이 플랜인가)

이 작업 직전에 **AWS 매니지드 이관**을 검토했다 (`docs/aws-architecture.html`, `docs/aws-architecture-layered.html` 참조). 결론:

- 사내 500명 규모 + 추가 기능(시간별 집계, 팀, 권한, 채팅)은 **Supabase가 모든 면에서 유리**.
- AWS 이관은 컴포넌트 수가 4~8개로 늘고, **RLS를 잃어** 권한 집행을 직접 구현해야 하며, 비용도 더 비쌈 (월 $25 vs $65–135).
- "사내 AWS 일원화 정책"이라는 제약이 있다면 강제 이관이 정당화되지만, **현재 그런 강제는 없음** → Supabase 유지로 결정.

**결론: AWS 이관 폐기. Supabase 위에서 두 가지 기능만 추가.**

`docs/aws-architecture*.html` 두 파일은 의사결정 이력 참고용으로 남겨두되, 구현 대상 아님.

---

## 1. 추가할 기능 (Scope)

| 영역 | 목표 |
|---|---|
| **시간별 측정** | 현재 일 단위 집계 → **시간 단위(UTC hour)** 도 함께 적재. 분 단위는 로컬 SQLite에만 (서버로 보내지 않음). |
| **팀 + 권한** | `teams` / `team_members` / `app_roles` 테이블 + RLS. 리더보드를 "전체 / 우리 팀" 토글 가능하게. |

기존 일별 집계(`usage_aggregates`)는 **그대로 유지** — 기존 화면이 안 깨지게.

---

## 2. DB 마이그레이션 (개념)

`supabase/migrations/00xx_hourly_and_teams.sql` 신규 작성:

```sql
-- ============================================================
-- 1) 시간별 집계
-- ============================================================
create table usage_hourly (
  user_id uuid not null references auth.users(id),
  hour_utc timestamptz not null,        -- date_trunc('hour', ts)
  tool text not null,                   -- 'claude' | 'codex' | 'gemini' ...
  model text not null,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  cache_creation_tokens bigint not null default 0,
  cost_usd numeric(12,6) not null default 0,
  request_count int not null default 0,
  primary key (user_id, hour_utc, tool, model)
);
create index on usage_hourly (hour_utc desc);
create index on usage_hourly (user_id, hour_utc desc);

-- ============================================================
-- 2) 팀
-- ============================================================
create table teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table team_members (
  team_id uuid not null references teams(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  role text not null check (role in ('owner','admin','member')),
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

-- ============================================================
-- 3) 전역 역할 (서비스 어드민 — 전체 데이터 열람용)
-- ============================================================
create table app_roles (
  user_id uuid primary key references auth.users(id),
  role text not null check (role in ('admin','user'))
);
```

---

## 3. RLS 정책

권한 데이터는 DB에 두고, 집행은 RLS가 함 (Supabase의 핵심 강점).

```sql
alter table usage_hourly enable row level security;
alter table teams enable row level security;
alter table team_members enable row level security;

-- usage_hourly
-- 본인 데이터는 항상 조회 가능
create policy "own usage" on usage_hourly
  for select using (user_id = auth.uid());

-- 같은 팀이고 + 옵트인된 사용자의 집계 조회 가능
create policy "team usage" on usage_hourly
  for select using (
    exists (
      select 1 from team_members tm1
      join team_members tm2 on tm1.team_id = tm2.team_id
      where tm1.user_id = auth.uid()
        and tm2.user_id = usage_hourly.user_id
    )
    and exists (
      select 1 from profiles p
      where p.user_id = usage_hourly.user_id and p.opt_in = true
    )
  );

-- 어드민은 전체
create policy "admin all usage" on usage_hourly
  for select using (
    exists (select 1 from app_roles where user_id = auth.uid() and role = 'admin')
  );

-- INSERT / UPDATE: 본인 행만
create policy "own insert usage" on usage_hourly
  for insert with check (user_id = auth.uid());
create policy "own update usage" on usage_hourly
  for update using (user_id = auth.uid());

-- team_members: 본인이 속한 팀의 멤버 목록만 조회
create policy "team members visible" on team_members
  for select using (
    team_id in (select team_id from team_members where user_id = auth.uid())
  );

-- teams: 본인이 속한 팀만 보이게
create policy "joined teams visible" on teams
  for select using (
    id in (select team_id from team_members where user_id = auth.uid())
  );
```

**기존 `usage_aggregates` 등 테이블에도 같은 패턴의 RLS를 적용**해야 권한이 새지 않음. 마이그레이션에서 함께 ALTER.

---

## 4. RPC (팀 단위 리더보드)

```sql
create or replace function get_team_top_users(p_team_id uuid, p_range text)
returns table(user_id uuid, total_tokens bigint, total_cost numeric)
language sql security invoker as $$
  select uh.user_id,
         sum(uh.input_tokens + uh.output_tokens) as total_tokens,
         sum(uh.cost_usd) as total_cost
  from usage_hourly uh
  where uh.user_id in (select user_id from team_members where team_id = p_team_id)
    and uh.hour_utc >= now() - case p_range
      when '1h'  then interval '1 hour'
      when '24h' then interval '24 hours'
      when '7d'  then interval '7 days'
      when '30d' then interval '30 days'
    end
  group by uh.user_id
  order by total_tokens desc
  limit 10;
$$;
```

**`security invoker` 필수** — RLS가 그대로 적용되어야 권한이 새지 않음. `security definer`로 만들면 안 됨.

기존 `get_top_users`, `get_top_mcp`, `get_top_plugins`, `get_weekly_top10` 도 시간별 데이터를 보도록 추가 변형 검토 (또는 그대로 일별 유지).

---

## 5. 클라이언트 변경 (파일별)

### Rust (Tauri)
| 파일 | 변경 |
|---|---|
| `src-tauri/src/db.rs` | 시간 단위 집계 쿼리 추가. `range_bounds()` 에 `'1h'` 케이스 추가. |
| `src-tauri/src/aggregator.rs` | 일별 업로드 + **시간 버킷 upsert**. 배치 크기 일별보다 ~24배라 chunking 필요. |
| `src-tauri/src/commands.rs` | `get_hourly_summary(range)`, `get_hourly_timeseries(range)` 등 시간 단위 명령. `lib.rs` 의 `invoke_handler!` 에 등록 잊지 말 것. |

### Frontend (React)
| 파일 | 변경 |
|---|---|
| `src/hooks/useUsage.ts` | `granularity: 'hour' \| 'day' \| 'week'` 옵션 추가. `'hour'` 면 `usage_hourly` 테이블 select. |
| `src/pages/Dashboard.tsx` | granularity Select 에 "시간" 추가. 차트 X축 포맷터에 `HH:mm` 케이스. |
| `src/pages/Leaderboard.tsx` | "전체 / 우리 팀" 토글 + 팀 선택 dropdown. `get_team_top_users(team_id, range)` 호출. |
| `src/pages/Teams.tsx` *(신규)* | 팀 생성 / 멤버 초대 / 역할 변경. Settings 하단 섹션으로 넣어도 무방. |
| `src/lib/supabase.ts` | 변경 없음 (기존 클라이언트 그대로). |
| `src/types/models.ts` | `Team`, `TeamMember`, `AppRole`, `HourlyPoint` 타입 추가. |

### i18n
- `src/i18n/ko.json` 에 키 추가: `teams.*`, `dashboard.granularity.hour`, `leaderboard.scope.{all,team}` 등.

---

## 6. 데이터량 점검

- 500명 × 24h × tool·model 약 5종 ≈ **일 6만 행, 연 ~2,200만 행**
- 행당 ~150B → **연 ~3GB** (인덱스 포함 ~5GB)
- Supabase Pro 8GB 한도 안에서 **2~3년 여유**. 더 지나면 90일 이상 raw 를 `usage_daily` 로 롤업하는 옵션 도입.

---

## 7. 미결정 / 결정 필요 사항

다음 세션에서 사용자에게 확인하면 좋은 것들:

1. **시간 버킷 타임존** — `UTC` 저장 + KST 표시 권장 (제안). 다른 의견 있는지 확인.
2. **팀 가입 모델** — 누구나 생성 + 슬랙 핸들/이메일 초대 (제안) vs 어드민이 배정.
3. **옵트인 단위** — 현재 전역 1개 유지 (제안) vs 팀별 별도.
4. **`usage_aggregates`(일별) 와의 관계** — 시간별 + 일별 이중 유지 vs 시간별만 두고 일별은 view 로 생성.
5. **분 단위는 정말 로컬에만?** — 추후 분석 요구 생기면 시간만 보낼 수 있음. 지금은 보내지 않음.

---

## 8. 실행 순서 제안

1. **마이그레이션 SQL 작성** (`supabase/migrations/00xx_hourly_and_teams.sql`) + Studio 적용 확인.
2. **기존 `usage_aggregates` 등에 RLS 추가** — 권한 누수 방지 (이게 누락되면 의미 없음).
3. **`aggregator.rs` 에 시간 버킷 업로드 추가** + 로컬 테스트.
4. **`useUsage.ts` + Dashboard "시간" granularity** 추가.
5. **Teams 페이지 + `get_team_top_users` 연동**.
6. **Leaderboard "우리 팀" 토글**.
7. **Settings — 팀 관리 / 권한 표시**.

---

## 9. 참고 — 이 플랜이 폐기한 대안

- **AWS 매니지드 이관** (AppSync + Aurora + Lambda + Cognito) — 컴포넌트 7~8개, 월 $65–135, RLS 상실로 권한 직접 구현 필요. → 폐기.
- **Supabase 셀프호스트 on AWS (ECS)** — AWS 일원화 정책이 "매니지드만 허용" 이라 탈락 가설이었으나, 실제로 그런 강제 없음 → 검토 종료.
- **AWS 네이티브 최소 구성** (AppSync 단독 + Aurora + Slack OIDC authorizer) — 단순하긴 하나 여전히 RLS 직접 구현 + 데이터레이어 재작성 필요 → 이득 없음.

세 대안의 시각화는 `docs/aws-architecture.html`, `docs/aws-architecture-layered.html` 에 남아 있음 (참고용).
