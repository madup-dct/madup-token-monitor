import { useEffect, useState } from "react";
import {
  check,
  type Update,
  type DownloadEvent,
} from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";

const IS_TAURI = "__TAURI_INTERNALS__" in window;
const NOTIFY_KEY = "madup-token-monitor:notifyOnUpdate";
// 메뉴바 앱은 며칠씩 떠 있으므로 시작 1회 체크만으로는 새 릴리즈를 못 본다 → 주기 폴링.
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

function notifyEnabled(): boolean {
  // notify_on_update 토글(기본 true) — Settings 가 localStorage 에 영속.
  try {
    const raw = localStorage.getItem(NOTIFY_KEY);
    if (raw != null) return JSON.parse(raw) as boolean;
  } catch {
    /* 기본 true 유지 */
  }
  return true;
}

/// 사이드바 업데이트 알림 카드 — 시작 시 + 1시간 주기로 업데이트 확인.
/// 새 버전이 있으면 사이드바 하단에 카드 표시, "지금 업데이트" 클릭 시
/// 다운로드 진행률 → 설치 → 재시작(restart_app)까지 자동.
/// "나중에"는 해당 버전만 숨김 — 더 새로운 버전이 나오면 다시 알린다.
/// 네트워크 실패는 조용히 무시(앱 사용을 막지 않음).
export function UpdateNotifier() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!IS_TAURI) return;
    let alive = true;

    async function runCheck() {
      if (!notifyEnabled()) return;
      try {
        const u = await check();
        if (alive && u?.available) setUpdate(u);
      } catch {
        /* 업데이트 서버 접근 실패는 조용히 무시 */
      }
    }

    runCheck();
    const timer = setInterval(runCheck, CHECK_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (!IS_TAURI || !update || update.version === dismissedVersion) return null;

  async function install() {
    if (!update) return;
    setDownloading(true);
    setProgress(0);
    setError(null);
    try {
      // contentLength 는 Started 에만, chunkLength(이번 청크)는 Progress 에만 온다 → 누적.
      let total = 0;
      let done = 0;
      await update.downloadAndInstall((e: DownloadEvent) => {
        switch (e.event) {
          case "Started":
            total = e.data.contentLength ?? 0;
            done = 0;
            setProgress(total > 0 ? 0 : null);
            break;
          case "Progress":
            done += e.data.chunkLength;
            if (total > 0) setProgress(Math.round((done / total) * 100));
            break;
          case "Finished":
            setProgress(100);
            break;
        }
      });
      await invoke("restart_app");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDownloading(false);
      setProgress(null);
    }
  }

  return (
    <div className="p-2.5 rounded-lg bg-azure-soft border border-hairline">
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-azure-bright animate-pulse shrink-0" />
        <span className="text-[11.5px] font-semibold text-text-primary truncate">
          새 버전 v{update.version}
        </span>
      </div>
      {error ? (
        <div className="text-[10.5px] text-rose-300 mt-1.5 break-words">
          {error}
        </div>
      ) : null}
      {downloading && progress != null ? (
        <div className="mt-2 h-1 rounded-full bg-surface-2 overflow-hidden">
          <div
            className="h-full bg-azure-bright transition-[width] duration-200"
            style={{ width: `${progress}%` }}
          />
        </div>
      ) : null}
      <div className="flex items-center gap-1.5 mt-2">
        <button
          type="button"
          onClick={install}
          disabled={downloading}
          className="flex-1 px-2 py-1 rounded-md bg-azure-bright text-[#06122b] text-[11px] font-semibold disabled:opacity-60"
        >
          {downloading
            ? progress != null
              ? `다운로드 중… ${progress}%`
              : "설치 중…"
            : "지금 업데이트"}
        </button>
        {!downloading ? (
          <button
            type="button"
            onClick={() => setDismissedVersion(update.version)}
            className="px-2 py-1 rounded-md bg-surface-2 text-text-secondary text-[11px] font-semibold"
          >
            나중에
          </button>
        ) : null}
      </div>
    </div>
  );
}
