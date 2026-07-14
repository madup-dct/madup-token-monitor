#!/usr/bin/env bash
# gitleaks pre-commit 훅 활성화 (개발자 1회 실행).
#
#   ./scripts/setup-gitleaks.sh
#
# gitleaks 바이너리가 있어야 한다:  brew install gitleaks
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "❌ gitleaks 가 설치되어 있지 않습니다."
  echo "   설치:  brew install gitleaks"
  exit 1
fi

git config core.hooksPath .githooks

echo "✅ core.hooksPath=.githooks 설정 완료 (gitleaks $(gitleaks version) 감지)."
echo "   이제 커밋할 때마다 staged 변경분을 gitleaks 가 스캔합니다."
echo "   전체 히스토리 1회 점검:  gitleaks git --redact -v -c .gitleaks.toml"
