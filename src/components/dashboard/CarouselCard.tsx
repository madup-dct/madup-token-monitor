import {
  useCallback,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { PrismCarousel } from "@/components/ui/PrismCarousel";

/// localStorage 읽기 (key 가 null 이면 메모리 전용 — fallback 반환).
function readPersisted<T>(key: string | null, fallback: T): T {
  if (!key) return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw != null ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/// localStorage 쓰기 후 값 반환 (key 가 null 이면 기록 생략).
function writePersisted<T>(key: string | null, value: T): T {
  if (key) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* localStorage 불가 환경 — 메모리 state 로만 동작 */
    }
  }
  return value;
}

/// SetStateAction 을 이전 값 기준으로 다음 값으로 해소.
function resolve<T>(action: SetStateAction<T>, prev: T): T {
  return typeof action === "function" ? (action as (p: T) => T)(prev) : action;
}

export interface CarouselFace {
  key: string;
  /// 활성 면일 때 헤더에 표시될 제목 (예: "활동", "MCP 사용량").
  title: string;
  /// 제목 옆 보조 라벨 (예: "최근 8주", "최근 7일"). 면마다 다를 수 있음.
  subtitle?: string;
  node: ReactNode;
}

export interface CarouselCardProps {
  faces: CarouselFace[];
  /// 면 높이 (px) — PrismCarousel 은 3D 회전체라 컨테이너 높이 고정 필요.
  height?: number;
  /// 카드 외곽 className (예: "col-span-4").
  className?: string;
  /// 지정하면 현재 면(idx)·자동회전(auto) 선택을 localStorage 에 영속 (라우트 이동/재시작 후 유지).
  /// 사용처마다 고유해야 함 (예: "madup-token-monitor:view:dash:activity").
  persistKey?: string;
}

/// 헤더(회전 제목 + 이전/점/다음 + 자동토글) + PrismCarousel 을 묶은 공통 carousel 카드.
/// Dashboard / UserDashboard 의 활동·MCP·플러그인·도구·프로젝트 페이지 넘김 UI 에 사용.
/// 면 내용(node)은 호출자가 구성 — 카드 chrome 만 공유한다.
export function CarouselCard({ faces, height = 320, className = "", persistKey }: CarouselCardProps) {
  // persistKey 가 있으면 lazy init 으로 localStorage 에서 마지막 선택을 읽어 깜빡임 없이 복원.
  // 훅 규칙: 항상 동일하게 useState 두 개만 호출하고, persistKey 유무로 초기화/기록만 분기.
  const idxKey = persistKey ? `${persistKey}:idx` : null;
  const autoKey = persistKey ? `${persistKey}:auto` : null;
  const [idx, setIdxRaw] = useState<number>(() => readPersisted(idxKey, 0));
  const [auto, setAutoRaw] = useState<boolean>(() => readPersisted(autoKey, true));
  const setIdx = useCallback<Dispatch<SetStateAction<number>>>(
    (action) => setIdxRaw((prev) => writePersisted(idxKey, resolve(action, prev))),
    [idxKey],
  );
  const setAuto = useCallback<Dispatch<SetStateAction<boolean>>>(
    (action) => setAutoRaw((prev) => writePersisted(autoKey, resolve(action, prev))),
    [autoKey],
  );
  const n = faces.length;
  const active = faces[Math.min(idx, n - 1)];

  return (
    <section className={`mc-card ${className}`}>
      <header className="flex items-center justify-between mb-3.5 gap-3 relative">
        <span className="text-[15px] font-semibold text-text-primary tracking-[-0.005em]">
          {active?.title}
          {active?.subtitle ? (
            <span className="text-text-tertiary font-normal text-[12px] ml-1">
              {active.subtitle}
            </span>
          ) : null}
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setIdx((i) => (i + n - 1) % n)}
            aria-label="이전"
            title="이전"
            className="mc-icon-btn"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10 3L5 8l5 5" />
            </svg>
          </button>
          <div className="flex items-center gap-1.5">
            {faces.map((f, i) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setIdx(i)}
                aria-label={f.title}
                className="w-2 h-2 rounded-full transition-colors"
                style={{
                  background: i === idx ? "var(--color-azure)" : "var(--color-surface-3)",
                }}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() => setIdx((i) => (i + 1) % n)}
            aria-label="다음"
            title="다음"
            className="mc-icon-btn"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6 3l5 5-5 5" />
            </svg>
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={auto}
            onClick={() => setAuto((v) => !v)}
            title="자동 넘기기"
            className="relative w-[34px] h-[20px] rounded-full transition-colors shrink-0 ml-1"
            style={{
              background: auto ? "var(--color-azure)" : "var(--color-surface-3)",
            }}
          >
            <span
              className="absolute top-[2px] left-[2px] w-4 h-4 rounded-full transition-transform"
              style={{
                background: auto ? "#fff" : "var(--color-text-secondary)",
                transform: auto ? "translateX(14px)" : "translateX(0)",
              }}
            />
          </button>
        </div>
      </header>

      <PrismCarousel
        activeIndex={idx}
        onIndexChange={setIdx}
        auto={auto}
        intervalMs={5000}
        height={height}
        faces={faces.map((f) => ({ key: f.key, node: f.node }))}
      />
    </section>
  );
}
