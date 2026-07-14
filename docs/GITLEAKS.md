# gitleaks — 시크릿 커밋 방지

이 repo 는 자동 업데이트 / Slack OAuth 설정상 당분간 **public** 을 유지해야 한다.
public repo 는 지속적으로 크롤링되므로 시크릿이 한 번이라도 커밋되면 즉시 노출된다.
[gitleaks](https://github.com/gitleaks/gitleaks) 로 커밋 전(로컬)과 push 후(CI) 두 겹으로 차단한다.

## 구성

| 계층 | 파일 | 언제 도는가 |
|---|---|---|
| 로컬 pre-commit 훅 | `.githooks/pre-commit` | `git commit` 시 staged 변경분 스캔 |
| CI 백스톱 | `.github/workflows/gitleaks.yml` | push / PR 마다 전체 히스토리 스캔 |
| 설정 | `.gitleaks.toml` | 기본 룰셋 + 최소 allowlist |

CI 는 조직 라이선스가 필요한 공식 action 대신 gitleaks **CLI 바이너리를 직접 실행**한다.

## 개발자 셋업 (1회)

```bash
brew install gitleaks
./scripts/setup-gitleaks.sh   # core.hooksPath=.githooks 설정
```

미설치 상태로 커밋하면 훅은 경고만 하고 통과한다(CI 가 최종 차단). 그래도 로컬에서 먼저
걸러야 잘못된 값이 원격에 닿기 전에 막을 수 있으니 설치를 권장한다.

## 오탐 처리

- **한 줄만 예외**: 해당 줄 끝에 `# gitleaks:allow` 주석.
- **패턴/경로 예외**: `.gitleaks.toml` 의 `[allowlist]` 에 **최소 범위로만** 추가.
  - ✅ 예: `sb_publishable_...` (Supabase publishable/anon key — 클라이언트 공개용, RLS 보호),
    `.env.example` (placeholder 전용 예시 파일).
  - ❌ 금지: `.env` 경로 전체를 allowlist 하지 말 것 — 미래의 실제 시크릿(`sb_secret_...`,
    Slack secret, AWS 키)까지 삼켜 버린다.

## 수동 전체 스캔

```bash
gitleaks git --redact -v -c .gitleaks.toml     # 전체 히스토리
gitleaks git --staged --redact -v -c .gitleaks.toml   # staged 만 (훅과 동일)
```

## 참고

- 과거 커밋 `8b0f664` 에 `.env` 가 잠깐 올라갔으나 내용은 Supabase publishable key(공개 설계값)
  뿐이라 실제 시크릿 유출이 아니다 → 키 로테이션/히스토리 재작성 불필요. 해당 패턴은 allowlist 로 처리.
