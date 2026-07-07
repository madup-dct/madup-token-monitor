#!/usr/bin/env bash
# 로컬 릴리즈 — macOS(aarch64 + x86_64) 빌드·서명 + latest.json 생성 + GitHub Release 업로드.
#
# 기존 .github/workflows/release.yml (tauri-action) 을 대체. CI macOS 러너 비용을 없애려고
# 모든 빌드를 로컬에서 수행한다. Windows(nsis) 는 macOS 에서 빌드 불가 → 배포에서 제외.
#
# 사용:
#   1) package.json + src-tauri/tauri.conf.json 의 version 을 동일하게 bump + commit
#   2) 서명 키 준비 — 둘 중 하나:
#        (a) 로컬 export:
#              export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/madup-token-monitor.key)"
#              export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='<생성 시 비밀번호>'
#        (b) 아무것도 export 안 하면 SSM Parameter Store 에서 자동 조달 (aws CLI 필요).
#            자세한 셋업은 docs/AUTO_UPDATE_SETUP.md 1.1/1.2 참고.
#   3) bash scripts/release.sh
#   4) 생성된 Draft Release 검토 후 publish:
#        gh release edit "v<version>" --draft=false
set -euo pipefail

REPO="madup-dct/madup-token-monitor"
PRODUCT="madup-token-monitor"
TARGETS=(aarch64-apple-darwin x86_64-apple-darwin)

cd "$(dirname "$0")/.."

# --- 서명 키: env 없으면 SSM Parameter Store 에서 조달 --------------------
# 개인키/비밀번호를 로컬에 두거나 암기할 필요 없이, dct-madup 계정 SSM 에 저장해둔
# SecureString 을 권한 있는 팀원이 런타임에 fetch. env 로 직접 export 하면 그게 우선.
AWS_REGION="${AWS_REGION:-ap-northeast-2}"
SSM_KEY_PARAM="/madup-token-monitor/tauri-signing-private-key"
SSM_PW_PARAM="/madup-token-monitor/tauri-signing-private-key-password"

ssm_fetch() {  # $1 = parameter name → 복호화된 값을 stdout 으로
  aws ssm get-parameter --name "$1" --with-decryption \
    --query Parameter.Value --output text --region "$AWS_REGION"
}

if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ] || [ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]; then
  command -v aws >/dev/null || { echo "::error:: 서명 키 env 미설정 + aws CLI 없음 — 키를 export 하거나 aws CLI 설치"; exit 1; }
  echo "▶ 서명 키 env 미설정 → SSM Parameter Store 에서 조달 (${AWS_REGION})"
  : "${TAURI_SIGNING_PRIVATE_KEY:=$(ssm_fetch "$SSM_KEY_PARAM")}"
  : "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:=$(ssm_fetch "$SSM_PW_PARAM")}"
  export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
fi

# --- 사전 점검 -------------------------------------------------------------
: "${TAURI_SIGNING_PRIVATE_KEY:?개인키를 얻지 못함 (env export 또는 SSM ${SSM_KEY_PARAM} 확인)}"
: "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:?비밀번호를 얻지 못함 (env export 또는 SSM ${SSM_PW_PARAM} 확인)}"
command -v gh >/dev/null  || { echo "::error:: gh CLI 필요"; exit 1; }
gh auth status >/dev/null || { echo "::error:: gh 로그인 필요 (gh auth login)"; exit 1; }

# .env 프론트 필수값 가드 — VITE_SUPABASE_URL 이 없으면 vite 가 빈 값으로 inline 해
# 앱이 시작 즉시 supabase createClient 에서 크래시(빈 화면)한다 (v0.8.0 사고 재발 방지).
if ! grep -qE '^VITE_SUPABASE_URL=https' .env 2>/dev/null; then
  echo "::error:: .env 에 VITE_SUPABASE_URL(https…) 이 없다. Supabase 값을 .env 에 채워라 (.env.example 참고). 빌드 중단."
  exit 1
fi

VERSION="$(node -p "require('./package.json').version")"
CONF_VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
if [ "$VERSION" != "$CONF_VERSION" ]; then
  echo "::error:: version 불일치 — package.json($VERSION) vs tauri.conf.json($CONF_VERSION)"
  exit 1
fi
TAG="v${VERSION}"
echo "▶ 릴리즈 대상: ${TAG}"

# --- 빌드 ------------------------------------------------------------------
for target in "${TARGETS[@]}"; do
  rustup target add "$target" >/dev/null 2>&1 || true
  echo "▶ 빌드: $target"
  pnpm tauri build --target "$target"
done

# 빌드 산출 프론트 번들에 Supabase URL 이 실제로 inline 됐는지 확인 (env inlining 실패 방어).
# 없으면 앱이 빈 화면으로 시작하므로 업로드하지 않고 중단.
if ! grep -q 'supabase\.co' dist/assets/index-*.js 2>/dev/null; then
  echo "::error:: 빌드된 번들에 Supabase URL 이 inline 되지 않았다 — env 확인 필요. 업로드 중단."
  exit 1
fi

# --- 아티팩트 수집 + latest.json 조립 --------------------------------------
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PLATFORMS=""   # latest.json platforms 항목 (콤마로 구분 — trailing comma 안 생기게 prepend)
PSEP=""        # 두 번째 항목부터 앞에 ",\n" 를 붙인다

for target in "${TARGETS[@]}"; do
  BUNDLE="src-tauri/target/${target}/release/bundle"
  arch="${target%%-*}"  # aarch64 | x86_64
  # bash 3.2(macOS 기본)엔 연관배열(declare -A)이 없어 case 로 tauri updater platform 키 매핑.
  case "$target" in
    aarch64-apple-darwin) key="darwin-aarch64" ;;
    x86_64-apple-darwin)  key="darwin-x86_64" ;;
    *) echo "::error:: 알 수 없는 target $target"; exit 1 ;;
  esac

  # 업데이터 아티팩트 (.app.tar.gz + .sig) — 두 타깃이 동일 basename 이라 arch 접미사로 충돌 회피
  src_tar="$(echo "$BUNDLE"/macos/*.app.tar.gz)"
  [ -f "$src_tar" ] || { echo "::error:: $src_tar 없음"; exit 1; }
  tar_name="${PRODUCT}_${VERSION}_${arch}.app.tar.gz"
  cp "$src_tar"        "$STAGE/$tar_name"
  cp "${src_tar}.sig"  "$STAGE/${tar_name}.sig"
  sig="$(cat "${src_tar}.sig")"
  url="https://github.com/${REPO}/releases/download/${TAG}/${tar_name}"

  # dmg (사람이 직접 받는 설치 파일) — 이미 arch 가 파일명에 포함됨
  cp "$BUNDLE"/dmg/*.dmg "$STAGE/"

  PLATFORMS="${PLATFORMS}${PSEP}    \"${key}\": { \"signature\": \"${sig}\", \"url\": \"${url}\" }"
  PSEP=$',\n'   # 다음 항목부터 콤마+개행으로 구분 (bash 3.2 의 %-pattern 제거 회피)
done

# latest.json 작성 (PLATFORMS 는 이미 콤마 구분·trailing comma 없음)
cat > "$STAGE/latest.json" <<EOF
{
  "version": "${VERSION}",
  "notes": "GitHub Releases에서 자동 업데이트가 지원됩니다.",
  "pub_date": "${PUB_DATE}",
  "platforms": {
${PLATFORMS}
  }
}
EOF

echo "▶ 업로드 파일:"
ls -1 "$STAGE"

# --- GitHub Release (Draft) ------------------------------------------------
gh release create "$TAG" "$STAGE"/* \
  --repo "$REPO" \
  --draft \
  --title "매드업 토큰 모니터 ${TAG}" \
  --notes "## 변경 사항
GitHub Releases에서 자동 업데이트가 지원됩니다.

### 설치
- macOS (Apple Silicon): \`*_aarch64.dmg\`
- macOS (Intel): \`*_x64.dmg\`"

echo "✓ Draft Release 생성 완료: https://github.com/${REPO}/releases/tag/${TAG}"
echo "  검토 후 발행:  gh release edit ${TAG} --draft=false"
