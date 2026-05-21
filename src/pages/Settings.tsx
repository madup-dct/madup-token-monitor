import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { useQueryClient } from "@tanstack/react-query";
import {
  enable as enableAutostart,
  disable as disableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import { supabase } from "../lib/supabase";
import { syncAggregatesNow, type SyncResult } from "../lib/auth";
import { useAuthUser } from "../hooks/useAuthUser";
import { Avatar } from "../components/Avatar";

const IS_TAURI = "__TAURI_INTERNALS__" in window;

// =============================================================================
// localStorage cache keys — Settings 진입 시 깜빡임 방지.
// =============================================================================
const AUTOSTART_CACHE_KEY = "madup-token-monitor:autostart";
const DATA_DIR_CACHE_KEY = "madup-token-monitor:dataDir";
const LAST_SYNC_KEY = "madup-token-monitor:lastSync";

interface AppSettings {
  show_menubar_cost?: boolean;
  notify_on_update?: boolean;
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota — silent */
  }
}

function formatRelative(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}초 전`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}분 전`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3600_000)}시간 전`;
  return `${Math.floor(ms / 86_400_000)}일 전`;
}

function formatAbsolute(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

export default function Settings() {
  const { user } = useAuthUser();
  const queryClient = useQueryClient();


  // App behavior
  const [autostart, setAutostart] = useState<boolean>(
    () => readJson<boolean>(AUTOSTART_CACHE_KEY) ?? false,
  );
  const [autostartReady, setAutostartReady] = useState(false);
  const [showMenubarCost, setShowMenubarCost] = useState<boolean>(true);
  const [notifyOnUpdate, setNotifyOnUpdate] = useState<boolean>(true);

  // App info
  const [dataDir, setDataDir] = useState<string | null>(
    () => readJson<string>(DATA_DIR_CACHE_KEY),
  );
  const [appVersion, setAppVersion] = useState<string | null>(null);

  // Sync
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<Date | null>(() => {
    const v = readJson<string>(LAST_SYNC_KEY);
    return v ? new Date(v) : null;
  });
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Danger zone
  const [clearing, setClearing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // ───────────────────────────────────────────────────────────────────────────
  // Bootstrap
  // ───────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!IS_TAURI) {
      setAutostartReady(true);
      return;
    }
    isAutostartEnabled()
      .then((on) => {
        setAutostart(on);
        writeJson(AUTOSTART_CACHE_KEY, on);
      })
      .catch(() => {})
      .finally(() => setAutostartReady(true));
    invoke<string>("get_data_dir")
      .then((dir) => {
        setDataDir(dir);
        writeJson(DATA_DIR_CACHE_KEY, dir);
      })
      .catch(() => {});
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
    invoke<AppSettings | null>("get_settings")
      .then((s) => {
        if (s && typeof s === "object") {
          setShowMenubarCost(s.show_menubar_cost ?? true);
          setNotifyOnUpdate(s.notify_on_update ?? true);
        }
      })
      .catch(() => {});
  }, []);

  // ───────────────────────────────────────────────────────────────────────────
  // Handlers
  // ───────────────────────────────────────────────────────────────────────────
  async function handleAutostartChange(next: boolean) {
    setAutostart(next);
    try {
      if (next) await enableAutostart();
      else await disableAutostart();
      writeJson(AUTOSTART_CACHE_KEY, next);
    } catch (err) {
      console.warn("[autostart] toggle failed:", err);
      setAutostart(!next);
    }
  }

  async function handleShowMenubarCostChange(next: boolean) {
    setShowMenubarCost(next);
    if (!IS_TAURI) return;
    invoke("set_setting", { key: "show_menubar_cost", value: next }).catch(
      () => setShowMenubarCost(!next),
    );
  }

  async function handleNotifyOnUpdateChange(next: boolean) {
    setNotifyOnUpdate(next);
    if (!IS_TAURI) return;
    invoke("set_setting", { key: "notify_on_update", value: next }).catch(
      () => setNotifyOnUpdate(!next),
    );
  }

  async function handleOpenDataFolder() {
    if (!dataDir) return;
    await openPath(dataDir).catch(() => {});
  }

  async function handleSyncNow() {
    setSyncing(true);
    setSyncError(null);
    setSyncResult(null);
    try {
      const result = await syncAggregatesNow();
      if (result) {
        setSyncResult(result);
        const now = new Date();
        setLastSync(now);
        writeJson(LAST_SYNC_KEY, now.toISOString());
      } else {
        setSyncError("로그인되어 있지 않거나 환경설정 누락");
      }
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
  }

  async function handleClearCache() {
    if (!IS_TAURI) return;
    if (!confirm("캐시를 비우시겠습니까? 차트/쿼리 캐시만 비우고 SQLite 원본은 유지됩니다.")) return;
    setClearing(true);
    try {
      const bytes = await invoke<number>("clear_cache_dir");
      // React Query persist 도 같이 비우기.
      try {
        localStorage.removeItem("madup-token-monitor:rq");
      } catch {
        /* ignore */
      }
      queryClient.clear();
      alert(`캐시 비움 완료. ${(bytes / 1024).toFixed(1)} KB 정리됨.`);
    } catch (e) {
      alert("캐시 비우기 실패: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setClearing(false);
    }
  }

  async function handleDeleteAll() {
    if (!IS_TAURI) return;
    const ok = confirm(
      "모든 로컬 데이터 (SQLite + 설정) 를 영구 삭제합니다.\n되돌릴 수 없습니다.\n앱 재시작 후 빈 상태로 시작됩니다.\n\n진행할까요?",
    );
    if (!ok) return;
    const ok2 = confirm("정말 삭제할까요? 마지막 확인입니다.");
    if (!ok2) return;
    setDeleting(true);
    try {
      await invoke("delete_all_data");
      try {
        localStorage.clear();
      } catch {
        /* ignore */
      }
      alert("삭제 완료. 앱을 재시작해주세요.");
    } catch (e) {
      alert("삭제 실패: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setDeleting(false);
    }
  }

  function handleOpenExternal(url: string) {
    if (IS_TAURI) {
      openUrl(url).catch(() => {});
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  const lastSyncRel =
    lastSync ? formatRelative(Date.now() - lastSync.getTime()) : null;

  // ───────────────────────────────────────────────────────────────────────────
  // Render
  // ───────────────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-[800px] mx-auto px-8 pt-8 pb-16">
      {/* Page header */}
      <p className="mc-eyebrow text-azure mb-3">ACCOUNT &amp; PRIVACY</p>
      <h1 className="text-[36px] font-bold tracking-[-0.01em] text-text-primary leading-[1.1] mb-2">
        설정
      </h1>
      <p className="text-[14px] text-text-secondary mb-8 max-w-[640px]">
        계정 · 데이터 정책 · 앱 동작 · 버전 정보를 관리합니다. 원시 토큰 데이터는
        항상 이 디바이스를 떠나지 않습니다.
      </p>

      <div className="flex flex-col gap-4">
        {/* ============ 01 · 계정 ============ */}
        <Card num="01" eyebrow="계정" title="로그인된 사용자">
          {user ? (
            <div className="flex items-center gap-4 py-1">
              {user.avatarUrl ? (
                <Avatar
                  src={user.avatarUrl}
                  name={user.name}
                  size={56}
                  rounded="full"
                  className="shadow-[0_0_0_1px_var(--color-hairline),inset_0_1px_0_rgba(255,255,255,0.2)]"
                />
              ) : (
                <Avatar src={null} name={user.name} size={56} rounded="full" />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-[17px] font-bold text-text-primary leading-tight mb-0.5 truncate">
                  {user.name || "(이름 없음)"}
                </div>
                <div className="num text-[12.5px] text-text-tertiary truncate">
                  {user.email}
                </div>
                <div className="flex gap-3 mt-2 text-[11.5px] text-text-secondary flex-wrap">
                  <span>
                    <strong className="num text-text-primary font-semibold mr-1">
                      Slack
                    </strong>
                    {user.slackHandle ? `@${user.slackHandle}` : "연동됨"}
                  </span>
                  <span>·</span>
                  <span className="text-lime">● 사내 집계 공유 중</span>
                </div>
              </div>
              <button
                type="button"
                onClick={handleSignOut}
                className="inline-flex items-center gap-2 h-[34px] px-4 border border-hairline-strong rounded-md bg-transparent text-coral text-[13px] font-semibold hover:border-coral hover:bg-coral-soft transition-colors whitespace-nowrap"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M6 3H3v10h3M10 5l3 3-3 3M13 8H6" />
                </svg>
                로그아웃
              </button>
            </div>
          ) : (
            <p className="text-[12px] text-text-tertiary">
              로그인 정보를 불러올 수 없습니다.
            </p>
          )}
        </Card>

        {/* ============ 02 · 데이터 정책 ============ */}
        <Card num="02" eyebrow="데이터 정책" title="사내 집계">
          <p className="text-[13px] text-text-secondary leading-relaxed mb-3.5">
            사내 집계는{" "}
            <strong className="text-text-primary font-semibold">
              모니터링 목적으로 항상 공유
            </strong>
            됩니다. 토큰 카운트와 비용 합계만 본인 계정으로 업로드되며,{" "}
            <span className="text-lime">
              원시 로그나 대화 내용은 절대 전송되지 않습니다.
            </span>{" "}
            같은 Slack 계정의 여러 디바이스 사용량은 자동으로 합산됩니다.
          </p>

          {user && (
            <div className="mt-4 pt-4 border-t border-hairline">
              <div className="flex justify-between items-start gap-4">
                <div className="flex-1 min-w-0">
                  <div className="text-[13.5px] font-semibold text-text-primary mb-1">
                    사내 집계 즉시 동기화
                  </div>
                  <div className="text-[12px] text-text-tertiary leading-relaxed">
                    앱 시작 후 5초, 그 다음 1시간마다 자동 동기화됩니다.
                    {lastSync && (
                      <>
                        {" "}
                        마지막 동기화:{" "}
                        <span className="num text-text-secondary">
                          {lastSyncRel} · {formatAbsolute(lastSync)}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleSyncNow}
                  disabled={syncing}
                  className="mc-btn-primary h-8 px-3.5 text-[12.5px] disabled:opacity-70"
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    className={syncing ? "animate-spin" : undefined}
                  >
                    <path d="M2 8a6 6 0 0110.3-4.2L14 2v4h-4M14 8a6 6 0 01-10.3 4.2L2 14v-4h4" />
                  </svg>
                  {syncing ? "동기화 중…" : "지금 동기화"}
                </button>
              </div>
              {syncResult && (
                <p className="text-[11.5px] text-lime mt-2">
                  ✓ 동기화 완료 — 사용량 {syncResult.usage_rows}건 / MCP{" "}
                  {syncResult.mcp_rows}건 / 플러그인 {syncResult.plugin_rows}건
                </p>
              )}
              {syncError && (
                <p className="text-[11.5px] text-coral mt-2 break-all">
                  동기화 실패: {syncError}
                </p>
              )}
            </div>
          )}

          <Notice>
            모니터링 목적의 사내 도구이므로 집계는 옵트아웃할 수 없습니다. 단,
            전송되는 데이터는 토큰/비용 합계뿐이며 원본은 로컬을 떠나지 않습니다.
          </Notice>
        </Card>

        {/* ============ 03 · 앱 동작 ============ */}
        <Card num="03" eyebrow="앱 동작" title="실행 · 표시 옵션">
          <SwitchRow
            checked={autostart}
            disabled={!IS_TAURI || !autostartReady}
            onChange={handleAutostartChange}
            label="로그인 시 자동 시작"
            description="OS 로그인 시 백그라운드로 실행됩니다. 트레이/메뉴바 아이콘에서 창을 다시 띄울 수 있습니다."
          />
          <SwitchRow
            checked={showMenubarCost}
            disabled={!IS_TAURI}
            onChange={handleShowMenubarCostChange}
            label="트레이/메뉴바에 오늘 사용량 표시"
            description="트레이/메뉴바 아이콘 옆(또는 tooltip)에 오늘 사용한 USD 금액이 1분마다 갱신됩니다."
          />
          <SwitchRow
            checked={notifyOnUpdate}
            disabled={!IS_TAURI}
            onChange={handleNotifyOnUpdateChange}
            label="새 버전 알림 (준비 중)"
            description="GitHub Releases에 새 버전이 배포되면 알림으로 표시합니다. 알림 UI 는 추후 구현."
          />

          <div className="mt-4 pt-4 border-t border-hairline">
            <div className="text-[13.5px] font-semibold text-text-primary mb-1">
              데이터 폴더 위치
            </div>
            <div className="text-[12px] text-text-tertiary mb-1.5">
              로컬 SQLite 파일이 저장된 위치입니다. 원시 데이터는 이 폴더 외부로
              나가지 않습니다.
            </div>
            <div className="flex justify-between items-center gap-3">
              <div
                className="num text-[11px] text-text-secondary px-2.5 py-1.5 border border-hairline rounded-md flex-1 break-all"
                style={{ background: "var(--color-surface-1)" }}
              >
                {dataDir ?? "~/Library/Application Support/madup-token-monitor"}
              </div>
              <button
                type="button"
                onClick={handleOpenDataFolder}
                disabled={!IS_TAURI || !dataDir}
                className="inline-flex items-center gap-1.5 h-8 px-3.5 rounded-md bg-surface-1 border border-hairline-strong text-text-primary text-[12.5px] font-semibold hover:border-text-tertiary transition-colors whitespace-nowrap disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M2 6h12v8a1 1 0 01-1 1H3a1 1 0 01-1-1V6z" />
                  <path d="M2 6V3a1 1 0 011-1h3l2 2h5a1 1 0 011 1v1" />
                </svg>
                Finder에서 열기
              </button>
            </div>
          </div>
        </Card>

        {/* ============ 04 · 앱 정보 ============ */}
        <Card num="04" eyebrow="앱 정보" title="버전 · 도움말">
          <div className="flex flex-col">
            <InfoRow
              label="현재 버전"
              value={<span className="num text-azure">{appVersion ?? "—"}</span>}
              accessory={
                <span
                  className="inline-flex items-center gap-1.5 h-[26px] px-3 rounded-full text-[11.5px] font-semibold"
                  style={{
                    background: "var(--color-lime-soft)",
                    color: "var(--color-lime)",
                  }}
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 8l4 4 6-7" />
                  </svg>
                  최신
                </span>
              }
            />
            <InfoRow
              label="자동 업데이트"
              value="GitHub Releases — 새 버전 배포 시 시작 시 알림 (준비 중)"
              accessory={
                <span className="text-[11px] text-text-tertiary">
                  마지막 확인 <span className="num">시작 시점</span>
                </span>
              }
            />
            <InfoRow
              label="소스 코드"
              value={
                <span className="num text-azure">
                  madup-dct/madup-token-monitor
                </span>
              }
              accessory={
                <ExternalLink
                  onClick={() =>
                    handleOpenExternal(
                      "https://github.com/madup-dct/madup-token-monitor",
                    )
                  }
                >
                  GitHub
                </ExternalLink>
              }
            />
            <InfoRow
              label="릴리스 노트"
              value="배포 노트 · Markdown"
              accessory={
                <ExternalLink
                  onClick={() =>
                    handleOpenExternal(
                      "https://github.com/madup-dct/madup-token-monitor/releases",
                    )
                  }
                >
                  Releases
                </ExternalLink>
              }
            />
            <InfoRow
              label="라이선스"
              value="MIT License"
              accessory={
                <ExternalLink
                  onClick={() =>
                    handleOpenExternal(
                      "https://github.com/madup-dct/madup-token-monitor/blob/main/LICENSE",
                    )
                  }
                >
                  LICENSE
                </ExternalLink>
              }
            />
          </div>
        </Card>

        {/* ============ 05 · 위험 구역 ============ */}
        <Card
          num="05"
          eyebrow="위험 구역"
          title="데이터 / 캐시 초기화"
          danger
        >
          <DangerRow
            label="로컬 캐시 초기화"
            description="차트 / 쿼리 캐시만 비웁니다. 원시 SQLite 데이터는 유지됩니다."
            buttonLabel={clearing ? "비우는 중…" : "캐시 비우기"}
            onClick={handleClearCache}
            disabled={clearing || !IS_TAURI}
            primary={false}
          />
          <DangerRow
            label="모든 로컬 데이터 삭제"
            description="SQLite 파일과 settings.json 을 영구 삭제합니다. 되돌릴 수 없습니다."
            buttonLabel={deleting ? "삭제 중…" : "전체 삭제"}
            onClick={handleDeleteAll}
            disabled={deleting || !IS_TAURI}
            primary
          />
        </Card>
      </div>
    </div>
  );
}

// =============================================================================
// Sub-components
// =============================================================================

interface CardProps {
  num: string;
  eyebrow: string;
  title: string;
  children: ReactNode;
  danger?: boolean;
}
function Card({ num, eyebrow, title, children, danger }: CardProps) {
  return (
    <section
      className="mc-card"
      style={
        danger
          ? { borderColor: "rgba(255,107,92,0.15)" }
          : undefined
      }
    >
      <div className="flex items-center gap-3 mb-1.5">
        <span
          className="num text-[11px] font-semibold text-text-faint px-2 py-0.5 rounded-md"
          style={{
            background: "var(--color-surface-2)",
            letterSpacing: "0.04em",
          }}
        >
          {num}
        </span>
        <span
          className={`text-[10.5px] font-bold tracking-[0.16em] uppercase ${
            danger ? "text-coral" : "text-text-tertiary"
          }`}
        >
          {eyebrow}
        </span>
      </div>
      <div
        className={`text-[18px] font-bold mb-3.5 ${
          danger ? "text-coral" : "text-text-primary"
        }`}
      >
        {title}
      </div>
      <div>{children}</div>
    </section>
  );
}

interface SwitchRowProps {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description: string;
}
function SwitchRow({
  checked,
  disabled,
  onChange,
  label,
  description,
}: SwitchRowProps) {
  return (
    <div
      className={`grid grid-cols-[1fr_auto] gap-4 items-center p-3.5 rounded-[10px] border border-hairline mb-2.5 last:mb-0 ${
        disabled ? "opacity-50" : ""
      }`}
      style={{ background: "var(--color-surface-2)" }}
    >
      <div className="min-w-0">
        <div className="text-[13.5px] font-semibold text-text-primary leading-snug mb-1">
          {label}
        </div>
        <div className="text-[12px] text-text-tertiary leading-relaxed">
          {description}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className="relative w-[38px] h-[22px] rounded-full transition-colors disabled:cursor-not-allowed shrink-0"
        style={{
          background: checked
            ? "var(--color-azure)"
            : "var(--color-surface-3)",
        }}
      >
        <span
          className="absolute top-[2px] left-[2px] w-[18px] h-[18px] rounded-full transition-transform"
          style={{
            background: checked ? "#fff" : "var(--color-text-secondary)",
            transform: checked ? "translateX(16px)" : "translateX(0)",
          }}
        />
      </button>
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex gap-2.5 items-start mt-3.5 p-3 rounded-[10px] text-[12px] text-azure-bright"
      style={{
        background: "var(--color-azure-soft)",
        border: "1px solid rgba(77,163,255,0.2)",
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="shrink-0 mt-0.5"
      >
        <circle cx="8" cy="8" r="6" />
        <path d="M8 5v3.5M8 11h.01" strokeLinecap="round" />
      </svg>
      <span>{children}</span>
    </div>
  );
}

interface InfoRowProps {
  label: string;
  value: ReactNode;
  accessory?: ReactNode;
}
function InfoRow({ label, value, accessory }: InfoRowProps) {
  return (
    <div className="grid grid-cols-[120px_1fr_auto] gap-4 items-center py-3 border-b border-hairline last:border-b-0">
      <span className="text-[12px] text-text-tertiary font-medium">{label}</span>
      <span className="text-[13px] text-text-primary font-medium min-w-0 truncate">
        {value}
      </span>
      <span className="shrink-0">{accessory}</span>
    </div>
  );
}

function ExternalLink({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[12px] text-azure font-semibold bg-transparent border-0 cursor-pointer inline-flex items-center gap-1 hover:text-azure-bright transition-colors"
    >
      {children}
      <svg
        width="9"
        height="9"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <path d="M5 2h9v9M5 11l9-9M2 6v8h8" />
      </svg>
    </button>
  );
}

interface DangerRowProps {
  label: string;
  description: string;
  buttonLabel: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}
function DangerRow({
  label,
  description,
  buttonLabel,
  onClick,
  disabled,
  primary,
}: DangerRowProps) {
  return (
    <div
      className="flex justify-between items-center p-3.5 rounded-[10px] mb-2.5 last:mb-0"
      style={{
        background: "var(--color-coral-soft)",
        border: "1px solid rgba(255,107,92,0.2)",
      }}
    >
      <div className="min-w-0">
        <div className="text-[13px] text-coral font-semibold">{label}</div>
        <div className="text-[11.5px] text-text-tertiary mt-0.5">
          {description}
        </div>
      </div>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="h-8 px-3.5 rounded-md text-[12.5px] font-semibold whitespace-nowrap shrink-0 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        style={
          primary
            ? {
                background: "var(--color-coral)",
                color: "#fff",
                border: 0,
              }
            : {
                background: "var(--color-surface-1)",
                color: "var(--color-text-primary)",
                border: "1px solid var(--color-hairline-strong)",
              }
        }
      >
        {buttonLabel}
      </button>
    </div>
  );
}
