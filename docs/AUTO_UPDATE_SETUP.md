# 자동 업데이트 셋업 (Tauri Updater)

GitHub Releases 기반으로 사내 동료가 앱을 받은 뒤 새 버전이 나올 때마다 자동 알림 → 업데이트되는 흐름입니다.

흐름 (로컬 릴리즈 — CI macOS 러너 비용 제거를 위해 GitHub Actions 미사용):
```
version bump + commit → bash scripts/release.sh
  → 로컬에서 macOS(arm64 + x86_64) 빌드 + 서명
  → latest.json 조립 + .dmg / .app.tar.gz / .sig 를 Draft Release 로 업로드
  → 검토 후 gh release edit v0.x.y --draft=false 로 publish
앱 실행 → updater plugin이 endpoint 의 latest.json 조회
  → 새 버전이면 다운로드 + 서명 검증 후 자동 업데이트
```
> Windows(nsis) 는 macOS 에서 빌드 불가 → 현재 배포는 macOS 2종(arm64/x86_64) 만.

---

## 1회성 셋업 (최초 1회)

### 1.1 서명 키쌍 생성

업데이트 패키지 무결성 검증용. 개인키는 절대 저장소에 커밋하지 않는다.

```bash
mkdir -p ~/.tauri
pnpm tauri signer generate -w ~/.tauri/madup-token-monitor.key
```

비밀번호 입력 → 다음 두 파일이 만들어집니다:
- `~/.tauri/madup-token-monitor.key` — **개인키 (secret)**
- `~/.tauri/madup-token-monitor.key.pub` — **공개키**

`.pub` 파일 내용을 복사해서 `src-tauri/tauri.conf.json` 의 `updater.pubkey` 에 붙여넣고 커밋:

```json
"updater": {
  "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6...",
  "endpoints": ["https://github.com/madup-dct/madup-token-monitor/releases/latest/download/latest.json"]
}
```

### 1.2 서명 키 제공 방법 (택1)

CI 를 쓰지 않으므로 서명 키는 **릴리즈를 돌리는 로컬 머신**이 쥐고 있어야 한다
(GitHub Secrets 불필요). `.env` 는 `docs/SUPABASE_SETUP.md` 기준으로 별도 작성.

**(a) 로컬 export** — 개인 머신에 키 파일이 있고 비밀번호를 알 때:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/madup-token-monitor.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='<1.1에서 입력한 비밀번호>'
```

**(b) AWS SSM Parameter Store** — 권장. 키/비밀번호를 팀 공용으로 중앙 보관해
"키 파일 복사"·"비밀번호 암기"에 의존하지 않는다. `release.sh` 는 위 env 가 비어 있으면
자동으로 아래 SecureString 을 fetch 한다 (dct-madup 654654319636, ap-northeast-2):

| 파라미터 | 값 |
|---|---|
| `/madup-token-monitor/tauri-signing-private-key` | `~/.tauri/madup-token-monitor.key` 전체 내용 |
| `/madup-token-monitor/tauri-signing-private-key-password` | 1.1 에서 입력한 비밀번호 |

최초 등록 (값 노출 방지: 비밀번호는 `read -s` 로 받아 argv/히스토리에 안 남김):

```bash
# 개인키 — cli-input-json 으로 넣어 ps 노출 회피
tmp="$(mktemp)"; chmod 600 "$tmp"
printf '{"Name":"/madup-token-monitor/tauri-signing-private-key","Type":"SecureString","Overwrite":true,"Value":%s}' \
  "$(jq -Rs . < ~/.tauri/madup-token-monitor.key)" > "$tmp"
aws ssm put-parameter --cli-input-json "file://$tmp" --region ap-northeast-2 >/dev/null; rm -f "$tmp"

# 비밀번호
read -rs "PW?🔑 서명 비밀번호: "; echo
aws ssm put-parameter --name /madup-token-monitor/tauri-signing-private-key-password \
  --type SecureString --value "$PW" --overwrite --region ap-northeast-2 >/dev/null; unset PW
```

> 읽기에는 `ssm:GetParameter` + `kms:Decrypt`(alias/aws/ssm) 권한 필요. DCT 팀 기본 IAM 은 이미 보유.
> Supabase DB 처럼, AWS 조작은 `aws-cli-agent` 로 위임하는 것이 팀 규칙.

---

## 매 릴리스마다

### 2.1 버전 올리기

`src-tauri/tauri.conf.json` + `package.json` 의 `version` 동기화:

```bash
# 둘 다 0.1.1 로
sed -i '' 's/"version": "0.1.0"/"version": "0.1.1"/' src-tauri/tauri.conf.json package.json
git commit -am "chore: bump version to 0.1.1"
```

### 2.2 로컬 빌드 + Draft Release 업로드

1.2(a) 로 서명 키를 export 했거나, 1.2(b) SSM 에 등록만 돼 있으면 (이 경우 아무 것도
export 안 해도 스크립트가 자동 fetch) 바로:

```bash
bash scripts/release.sh
```

→ macOS arm64 + x86_64 빌드·서명, `latest.json` 조립, `.dmg`/`.app.tar.gz`/`.sig` 를
   `v<version>` Draft Release 로 업로드 (~10분). 버전 불일치/키 누락 시 빌드 전에 중단.

### 2.3 Draft Release 검토 후 발행

스크립트는 `--draft` 로 올리므로 자동 publish 되지 않습니다.

1. https://github.com/madup-dct/madup-token-monitor/releases 진입
2. 생성된 **Draft** Release 확인 (`latest.json` + dmg 2개 + `.app.tar.gz`/`.sig` 첨부 확인)
3. Release notes 보강 후 **Publish** (또는 `gh release edit v0.1.1 --draft=false`)

→ `latest.json` 의 endpoint URL 이 살아나면서 기존 사용자들에게 자동 업데이트 알림이 뜸.

---

## 동작 확인

### 로컬 테스트
```bash
# 0.1.0 짜리 .app 을 /Applications/ 에 설치
# 0.1.1 release publish
# 0.1.0 앱 재실행 → 30초 내에 업데이트 dialog
```

### 디버그
업데이트 체크가 실패하면 앱 콘솔에서 `[updater]` 로그 확인. 자주 보는 케이스:
- **공개키 mismatch**: tauri.conf.json 의 pubkey 가 빌드 시 사용된 개인키와 짝이 안 맞음 → 키 새로 생성한 뒤 빌드 안 함
- **endpoint 401/403**: latest.json 이 비공개 라이센스에 가려짐 → repo public 또는 별도 호스팅
- **signature fail**: 빌드 환경의 `TAURI_SIGNING_PRIVATE_KEY` 가 다른 키쌍이거나 비밀번호 mismatch

---

## 보안 주의

- `~/.tauri/madup-token-monitor.key` 는 절대 커밋 금지. 잃으면 모든 사용자가 새 키로 재배포 받아야 함 (자동 업데이트 끊김)
- `tauri.conf.json` 에는 **공개키만** 들어가야 함. 시작 부분이 `untrusted comment: minisign public key:` 인지 확인
- 서명 비밀번호도 secret 로만 관리. 평문 저장 금지

---

## frontend 에서 수동 업데이트 체크 (선택)

기본은 앱 시작 시 자동 체크. 사용자가 Settings → "지금 업데이트 확인" 버튼을 원하면 `@tauri-apps/plugin-updater` 의 `check()` 호출. (현 시점 미구현 — 필요 시 추가)
