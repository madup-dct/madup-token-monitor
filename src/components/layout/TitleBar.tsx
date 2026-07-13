import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface TitleBarProps {
  title?: string;
  subtitle?: string;
}

// 인터랙티브 요소에 부여 — drag region 안에서도 클릭이 살아있게.
// 부모 wrapper 가 아니라 *실제 버튼 / pill* 에만 붙여야 빈 공간이 drag 로 남는다.
const NO_DRAG = { "data-tauri-drag-region": "false" } as const;

export function TitleBar({
  title = "매드업 토큰 모니터",
  subtitle,
}: TitleBarProps) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!IS_TAURI) return;
    const w = getCurrentWindow();
    w.isMaximized().then(setMaximized).catch(() => {});
    let cleanup: (() => void) | undefined;
    w.onResized(() => {
      w.isMaximized().then(setMaximized).catch(() => {});
    })
      .then((u) => {
        cleanup = u;
      })
      .catch(() => {});
    return () => {
      cleanup?.();
    };
  }, []);

  async function handleClose() {
    if (!IS_TAURI) return;
    // CloseRequested → lib.rs 에서 hide 로 흡수 → 트레이로 복귀.
    await getCurrentWindow().close().catch(() => {});
  }

  async function handleMinimize() {
    if (!IS_TAURI) return;
    await getCurrentWindow().minimize().catch(() => {});
  }

  async function handleMaximize() {
    if (!IS_TAURI) return;
    await getCurrentWindow().toggleMaximize().catch(() => {});
  }

  return (
    <div
      data-tauri-drag-region
      className="h-9 grid grid-cols-[1fr_auto_1fr] items-center px-4 border-b border-hairline bg-transparent select-none shrink-0"
      style={{ cursor: "default" }}
    >
      {/* macOS-style traffic lights — wrapper 는 drag-region 그대로, 버튼만 no-drag */}
      <div
        data-tauri-drag-region
        className="flex items-center gap-2 group h-full"
      >
        <button
          {...NO_DRAG}
          type="button"
          onClick={handleClose}
          aria-label="닫기"
          title="닫기"
          className="w-3 h-3 rounded-full bg-[#ff5f57] hover:opacity-80 transition-opacity flex items-center justify-center"
        >
          <svg
            width="6"
            height="6"
            viewBox="0 0 6 6"
            className="opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
          >
            <path
              d="M1 1l4 4M5 1l-4 4"
              stroke="#4d0000"
              strokeWidth="0.8"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <button
          {...NO_DRAG}
          type="button"
          onClick={handleMinimize}
          aria-label="최소화"
          title="최소화"
          className="w-3 h-3 rounded-full bg-[#febc2e] hover:opacity-80 transition-opacity flex items-center justify-center"
        >
          <svg
            width="6"
            height="2"
            viewBox="0 0 6 2"
            className="opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
          >
            <path d="M0 1h6" stroke="#5c3a00" strokeWidth="0.8" />
          </svg>
        </button>
        <button
          {...NO_DRAG}
          type="button"
          onClick={handleMaximize}
          aria-label={maximized ? "이전 크기" : "최대화"}
          title={maximized ? "이전 크기" : "최대화"}
          className="w-3 h-3 rounded-full bg-[#28c840] hover:opacity-80 transition-opacity"
        />
      </div>

      <div
        data-tauri-drag-region
        className="flex items-center gap-2 text-text-secondary text-[12px] whitespace-nowrap"
      >
        <span data-tauri-drag-region>{title}</span>
        {subtitle && (
          <>
            <span data-tauri-drag-region className="w-1 h-1 bg-text-faint rounded-full" />
            <span data-tauri-drag-region className="text-text-tertiary">
              {subtitle}
            </span>
          </>
        )}
      </div>

      <div data-tauri-drag-region aria-hidden="true" />
    </div>
  );
}
