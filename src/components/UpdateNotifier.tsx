import { useEffect, useState } from "react";
import {
  check,
  type Update,
  type DownloadEvent,
} from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";

const IS_TAURI = "__TAURI_INTERNALS__" in window;
const NOTIFY_KEY = "madup-token-monitor:notifyOnUpdate";

/// 앱 시작 시 1회 업데이트 확인 → 새 버전이 있으면 비차단 배너로 "알림 후 설치".
/// `notify_on_update` 토글이 꺼져 있으면 알리지 않는다(시작 체크 스킵).
/// "지금 업데이트" 클릭 시 다운로드·설치 진행률 표시 후 재시작(restart_app).
/// 시작 시 네트워크 실패는 조용히 무시(앱 사용을 막지 않음).
export function UpdateNotifier() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!IS_TAURI) return;
    // notify_on_update 토글(기본 true) — Settings 가 localStorage 에 영속.
    let notify = true;
    try {
      const raw = localStorage.getItem(NOTIFY_KEY);
      if (raw != null) notify = JSON.parse(raw) as boolean;
    } catch {
      /* 기본 true 유지 */
    }
    if (!notify) return;
    let alive = true;
    check()
      .then((u) => {
        if (alive && u?.available) setUpdate(u);
      })
      .catch(() => {
        /* 시작 시 업데이트 서버 접근 실패는 조용히 무시 */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!IS_TAURI || !update || dismissed) return null;

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
    <div className="fixed bottom-4 right-4 z-[300] w-[300px] mc-card p-4 shadow-xl">
      <div className="text-[12.5px] font-semibold text-text-primary">
        새 버전 v{update.version} 사용 가능
      </div>
      <div className="text-[11px] text-text-tertiary mt-1">
        업데이트하면 최신 기능·수정이 적용됩니다.
      </div>
      {error ? (
        <div className="text-[11px] text-rose-300 mt-2 break-words">{error}</div>
      ) : null}
      <div className="flex items-center gap-2 mt-3">
        <button
          type="button"
          onClick={install}
          disabled={downloading}
          className="flex-1 px-3 py-1.5 rounded-md bg-azure-bright text-[#06122b] text-[12px] font-semibold disabled:opacity-50"
        >
          {downloading
            ? `다운로드 중… ${progress != null ? `${progress}%` : ""}`
            : "지금 업데이트"}
        </button>
        {!downloading ? (
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="px-3 py-1.5 rounded-md bg-surface-2 text-text-secondary text-[12px] font-semibold"
          >
            나중에
          </button>
        ) : null}
      </div>
    </div>
  );
}
