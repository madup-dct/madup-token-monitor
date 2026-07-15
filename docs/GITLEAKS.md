# 시크릿 커밋 방지 (GitHub 전용)

이 repo 는 자동 업데이트 / Slack OAuth 설정상 당분간 **public** 을 유지해야 한다.
public repo 는 지속적으로 크롤링되므로 시크릿이 한 번이라도 push 되면 즉시 노출된다.
**개발자 로컬 설정 없이** GitHub 쪽에서 두 겹으로 막는다.

## 1. GitHub Push Protection (예방 — 주 방어선)

GitHub 네이티브 secret scanning + push protection. **push 되는 순간 GitHub 서버가**
시크릿이 포함된 push 를 거부하므로, 노출 자체가 예방된다. public repo 는 무료.

- 상태 확인: `gh api repos/madup-dct/madup-token-monitor --jq '.security_and_analysis'`
- 오탐으로 정상 push 가 막히면 GitHub 가 안내하는 bypass URL 에서 사유를 남기고 진행
  (또는 실제 시크릿이면 값을 제거·회전 후 다시 push).
- 커버리지: AWS/Slack/GitHub 등 **제공사 패턴** 위주. 제네릭/커스텀 시크릿은 아래 CI 가 보완.

## 2. gitleaks CI (백스톱 — 사후 탐지 + 전체 히스토리)

`.github/workflows/gitleaks.yml` — push/PR 마다 GitHub Actions 에서 전체 히스토리를 스캔한다.
제네릭 패턴(generic-api-key 등)과 과거 커밋까지 훑어 Push Protection 이 놓친 것을 잡는다.

- 조직 소유 repo 에 유료 라이선스를 요구하는 공식 action 대신 gitleaks **CLI 바이너리를
  직접 실행**한다 (버전 핀: `gitleaks.yml` 의 `GITLEAKS_VERSION`).
- 설정은 `.gitleaks.toml` (기본 룰셋 + 최소 allowlist).

## allowlist 원칙 (`.gitleaks.toml`)

- **`.env` 같은 경로 전체를 allowlist 하지 말 것.** 미래의 실제 시크릿(`sb_secret_...`,
  Slack secret, AWS 키)까지 삼킨다. 오탐은 한 줄만 `# gitleaks:allow`, 또는 패턴 단위로만.
- 현재 예외: `sb_publishable_...`(Supabase publishable/anon key — 클라이언트 번들에 실려
  공개되도록 설계된 값, RLS 보호) + `.env.example`(placeholder 전용).

## (선택) 로컬에서 직접 스캔

강제하지 않는다. 원하는 사람만 커밋 전 확인:

```bash
brew install gitleaks
gitleaks git --staged --redact -v -c .gitleaks.toml   # staged 변경분
gitleaks git --redact -v -c .gitleaks.toml            # 전체 히스토리
```

## 참고

- 과거 커밋 `8b0f664` 에 `.env` 가 잠깐 올라갔으나 내용은 Supabase publishable key(공개 설계값)
  뿐이라 실제 시크릿 유출이 아니다 → 키 로테이션/히스토리 재작성 불필요. 해당 패턴은 allowlist 로 처리.
