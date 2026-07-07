# 매드업 토큰 모니터

매드업 구성원의 Claude / MCP 토큰 사용량을 로컬에서 추적하고, 선택적으로 팀과 집계하는 데스크톱 앱입니다.

> macOS (Apple Silicon · Intel) 및 Windows x64 를 지원합니다. **Windows 빌드는 현재 BETA** — 로그인(딥링크 콜백) 경로가 실기기 미검증 상태입니다.

## 소개

- Claude Code / MCP JSONL 로그를 자동으로 파싱해 로컬 SQLite에 저장합니다.
- 일별/모델별 토큰 사용량 차트와 히트맵을 제공합니다.
- Slack 로그인 후 팀 채팅과 사내 집계 기능을 사용할 수 있습니다.
- **모든 원시 데이터는 로컬에만 저장되며, 집계 전송은 옵트인입니다.**

## 설치

1. [Releases](https://github.com/madup-dct/madup-token-monitor/releases/latest) 에서 본인 플랫폼에 맞는 파일 다운로드

   | 플랫폼 | 파일 |
   |--------|------|
   | macOS Apple Silicon (M1/M2/M3+) | `*_aarch64.dmg` |
   | macOS Intel | `*_x64.dmg` |
   | Windows x64 | `*-setup.exe` |

### macOS — Gatekeeper 경고 회피

2. dmg 마운트 → **Applications** 폴더로 드래그
3. **첫 실행 전** 터미널에서 한 번 실행 (Apple Developer ID 서명/notarization 미적용으로 인한 Gatekeeper 경고 회피):

   ```bash
   xattr -cr /Applications/madup-token-monitor.app
   ```

4. Launchpad 또는 Spotlight 에서 **매드업 토큰 모니터** 실행 → 메뉴바 우측 상단에 아이콘 표시

> 새 버전이 출시되면 앱 안에서 자동 업데이트 알림이 뜹니다. 자동 업데이트로 받은 버전은 quarantine 이 안 붙어서 위 `xattr` 명령을 다시 실행할 필요 없습니다.

### Windows — SmartScreen 경고 회피

사내 도구라 Authenticode 코드서명이 없으므로, Windows Defender SmartScreen 경고가 표시됩니다.

2. `*-setup.exe` 실행 시 "Windows의 PC 보호" 경고창이 나타나면:
   - **추가 정보(More info)** 클릭 → **실행(Run anyway)** 클릭
3. 설치 후 트레이(시스템 알림 영역)에 아이콘이 표시됩니다.

> **BETA 안내**: 현재 Windows 빌드는 BETA입니다. Slack 로그인(딥링크 OAuth 콜백) 경로가 실기기 미검증 상태이므로, 로그인이 정상 동작하지 않을 수 있습니다. 문제 발생 시 팀 채널에 알려주세요.

## Slack 연결

1. 앱을 실행하고 우측 상단 **설정** 으로 이동합니다.
2. **Slack으로 로그인** 버튼을 클릭합니다.
3. Slack OAuth 인증 후 팀 채팅과 집계 기능이 활성화됩니다.

> Supabase 프로젝트에서 Slack OIDC Provider를 활성화해야 합니다.
> `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` 환경 변수 설정이 필요합니다 (Dashboard > Settings > API > **Publishable key**).

## 데이터 정책

- 로컬 SQLite 파일 위치: `~/Library/Application Support/madup-token-monitor/data.db` (macOS)
- **토큰 사용량 집계 전송은 옵트인입니다.** 설정 화면에서 명시적으로 동의한 경우에만 익명화된 통계가 팀 대시보드에 집계됩니다.
- 원시 로그, 프롬프트, 대화 내용은 절대 전송되지 않습니다.
- 옵트인 설정은 언제든 설정 화면에서 철회할 수 있습니다.

## 개발 가이드

### 필요 환경

- Node.js 20+
- pnpm 9+
- Rust (stable)
- macOS (Xcode Command Line Tools 필요)

### 로컬 실행

```bash
# 의존성 설치
pnpm install

# 환경 변수 설정 (.env.local)
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...

# 개발 서버 실행
pnpm tauri dev
```

### 빌드

로컬 개발 빌드:

```bash
pnpm tauri build
```

### 릴리즈 (로컬)

GitHub Actions(macOS 러너) 비용 문제로 CI 빌드는 폐지했습니다. 릴리즈는 전부 로컬에서 수행합니다.

```bash
# 1) package.json + src-tauri/tauri.conf.json 의 version 을 동일하게 bump 후 commit
# 2) 로컬 릴리즈 스크립트 — macOS(arm64 + x86_64) 빌드·서명 + latest.json 조립 +
#    dmg / app.tar.gz / sig / latest.json 을 Draft Release 로 업로드
bash scripts/release.sh
# 3) 검토 후 발행
gh release edit v0.7.0 --draft=false
```

- **서명 키**: `release.sh` 는 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 환경변수가 있으면 그대로 쓰고, 없으면 **AWS SSM Parameter Store**(dct-madup, ap-northeast-2)에서 자동으로 가져옵니다. AWS 권한만 있으면 키 파일·비밀번호 없이 릴리즈할 수 있습니다. 셋업 상세는 [`docs/AUTO_UPDATE_SETUP.md`](docs/AUTO_UPDATE_SETUP.md) 참고.
- Windows(nsis) 는 macOS 에서 빌드 불가 → 현재 로컬 릴리즈 배포는 macOS 2종(arm64/x86_64)만 포함합니다.

### Supabase 마이그레이션

```bash
# supabase CLI 필요
supabase db push
```

마이그레이션 파일은 `supabase/migrations/` 에 있습니다:

| 파일 | 내용 |
|------|------|
| `0001_*` | 기본 스키마 |
| `0002_*` | 사용자 프로필 |
| `0003_*` | 집계 테이블 |
| `0004_messages.sql` | 팀 채팅 메시지 |

### 자동 업데이트 서버 설정

`tauri.conf.json`의 `plugins.updater.endpoints`를 사내 업데이트 서버 URL로 교체해야 합니다.
현재는 플레이스홀더가 설정되어 있습니다. Tauri updater 형식:

```
https://your-update-server.com/updates/{{target}}/{{current_version}}
```

## 라이선스

MIT License — 자세한 내용은 [LICENSE](LICENSE) 파일을 참고하세요.
