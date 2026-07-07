# GitHub Repository Secrets

> ⚠️ **CI 빌드 폐지됨** (macOS 러너 비용 폭주). `build.yml`/`release.yml` 삭제, 릴리즈는
> `scripts/release.sh` 로컬 전환. 현재 이 secrets 는 **불필요** — 로컬 `.env` + 서명 키 env 로 대체.
> 아래는 CI 를 다시 도입할 경우를 위한 참고 기록.

(과거) 이 앱의 CI 빌드 (`.github/workflows/build.yml`, `release.yml`) 가 사용하던 secrets.

`Settings → Secrets and variables → Actions → Repository secrets` 에 등록.

## 등록해야 할 5개 (필수)

| Secret 이름 | 출처 | 길이 (참고) | 용도 |
|---|---|---|---|
| `VITE_SUPABASE_URL` | Supabase Dashboard → Project Settings → API Keys → Project URL | ~40 chars | 프론트엔드가 Supabase 에 접속할 base URL. vite 가 빌드 시 `import.meta.env.VITE_SUPABASE_URL` 로 inline. |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase → API Keys → **anon public** 또는 **Publishable key** (`sb_publishable_*`) | 새 키는 ~46 chars / 구 JWT 는 ~200 chars | 클라이언트용 key. RLS 가 보호하므로 노출 OK. |
| `VITE_AUTH_SUCCESS_URL` | OAuth 후 브라우저가 forward 될 https URL. 보통 GitHub Pages | ~65 chars | 예: `https://madup-dct.github.io/madup-token-monitor/auth-callback/`. 이 페이지가 fragment 받아 deep link 로 forward + 탭 닫기. |
| `TAURI_SIGNING_PRIVATE_KEY` | `pnpm tauri signer generate` 로 만든 `~/.tauri/madup-token-monitor.key` 의 **전체 내용** (multi-line) | ~600 chars | Updater bundle 서명. `createUpdaterArtifacts: true` 라 필수. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 위 키 생성 시 입력한 **비밀번호** | 사용자 정의 | private key 복호화. |

`GITHUB_TOKEN` 은 GitHub Actions 가 자동 제공 (별도 등록 X).

## 등록 명령 (CLI)

```bash
# 권장: stdin 으로 줄바꿈 없이 등록 (붙여넣기 방식은 trailing newline 포함될 수 있음)
printf '%s' 'https://gkzihjshfgururghuxit.supabase.co' \
  | gh secret set VITE_SUPABASE_URL --repo madup-dct/madup-token-monitor

printf '%s' 'sb_publishable_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx' \
  | gh secret set VITE_SUPABASE_PUBLISHABLE_KEY --repo madup-dct/madup-token-monitor

printf '%s' 'https://madup-dct.github.io/madup-token-monitor/auth-callback/' \
  | gh secret set VITE_AUTH_SUCCESS_URL --repo madup-dct/madup-token-monitor

# 멀티라인 키는 파일에서 직접
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/madup-token-monitor.key --repo madup-dct/madup-token-monitor

# 비밀번호는 prompt 모드로 (히스토리 노출 방지)
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo madup-dct/madup-token-monitor
# → "Paste your secret:" 에 입력
```

## 검증

```bash
# 등록 목록 (값은 안 보임)
gh secret list --repo madup-dct/madup-token-monitor

# 빌드 시 실제 inject 됐는지 — release.yml 의 "Write .env" step 출력에서:
#   URL length: 40
#   KEY length: 46
#   SUCCESS_URL length: 65
# 길이가 0 이면 미등록 / 줄바꿈 포함이면 길이 + 1.
```

## 키 회전 (Tauri signing)

비밀번호 분실 또는 키 노출 시:

```bash
# 1) 새 키쌍 생성 (-f 로 기존 덮어쓰기)
pnpm tauri signer generate -f -w ~/.tauri/madup-token-monitor.key

# 2) 새 공개키를 tauri.conf.json 의 plugins.updater.pubkey 로 교체
cat ~/.tauri/madup-token-monitor.key.pub
# → 출력 base64 문자열을 src-tauri/tauri.conf.json 에 붙여넣기

# 3) GitHub Secret 두 개 모두 갱신
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/madup-token-monitor.key --repo madup-dct/madup-token-monitor
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo madup-dct/madup-token-monitor
```

> **주의**: 공개키 (`.pub`) 는 `tauri.conf.json` 에 들어가는 값.
> 개인키 (`.key`) 는 GitHub Secret 으로만, **절대 commit 금지** (`~/.tauri/` 도 .gitignore 와는 별개로 OS 권한으로 보호).

## .env 와 동기화

로컬 개발용 `.env` 는 위 5 항목 중 secret 인 것 (서명 키 제외) 만 동일하게.

```dotenv
# .env (gitignored)
VITE_SUPABASE_URL=https://gkzihjshfgururghuxit.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxxxxxxxxxxx
VITE_AUTH_SUCCESS_URL=https://madup-dct.github.io/madup-token-monitor/auth-callback/
```

이 세 변수는 vite 가 빌드 시 `import.meta.env.*` 로 inline. 로컬 빌드도 정확한 값이어야 OAuth / 사내 집계가 동작.

## CI 측 inject 메커니즘

`.github/workflows/{build,release}.yml` 의 **Write .env** step:

```yaml
- name: Write .env (vite inline)
  env:
    URL: ${{ secrets.VITE_SUPABASE_URL }}
    KEY: ${{ secrets.VITE_SUPABASE_PUBLISHABLE_KEY }}
    SUCCESS_URL: ${{ secrets.VITE_AUTH_SUCCESS_URL }}
  run: |
    if [ -z "$URL" ] || [ -z "$KEY" ] || [ -z "$SUCCESS_URL" ]; then
      echo "::error::Required secrets are missing or empty"
      exit 1
    fi
    {
      echo "VITE_SUPABASE_URL=$URL"
      echo "VITE_SUPABASE_PUBLISHABLE_KEY=$KEY"
      echo "VITE_AUTH_SUCCESS_URL=$SUCCESS_URL"
    } > .env
```

`tauri-action@v0` 가 step `env:` 의 `VITE_*` 를 sub-process 로 forwarding 하지 않는 케이스가 있어
**.env 파일을 직접 작성** 하는 패턴이 가장 robust. 새로운 `VITE_*` 변수가 생기면 위 step 에도
같이 추가해야 빌드에 inject 됨.

## 함정 모음

- **"Invalid API key" 무한 로딩** → publishable key 자리에 다른 종류 (service_role / 옛 JWT 등) 가 들어갔거나, 줄바꿈/따옴표 오염. 재등록 시 `printf '%s'` 사용.
- **빌드 마지막에 "incorrect updater private key password"** → `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 가 키 생성 시 비밀번호와 불일치. 키 회전이 더 빠른 fix.
- **`Required secrets are missing or empty`** → 위 step 의 fail-fast 메시지. `gh secret list` 로 등록 확인.
