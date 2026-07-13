import { useEffect, useState, type FocusEvent, type ReactNode } from "react";

interface PrismFace {
  key: string;
  node: ReactNode;
}

interface PrismCarouselProps {
  faces: PrismFace[];
  activeIndex: number;
  onIndexChange: (next: number) => void;
  /// 자동 전환 on/off
  auto: boolean;
  /// hover / 모달 열림 등으로 외부에서 일시정지
  paused?: boolean;
  intervalMs?: number;
  /// 면 높이 (px). 3D 회전체라 컨테이너 높이 고정 필요.
  height?: number;
  motion?: "prism" | "slide";
}

function prefersReducedMotion(): boolean {
  return (
    typeof globalThis.window !== "undefined" &&
    globalThis.window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

/// 가로축(rotateY) 회전 prism carousel. 3면 가정 (일/주/월).
/// prefers-reduced-motion 시 3D 대신 cross-fade.
export function PrismCarousel({
  faces,
  activeIndex,
  onIndexChange,
  auto,
  paused,
  intervalMs = 5000,
  height = 460,
  motion = "prism",
}: PrismCarouselProps) {
  const [hover, setHover] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const reduced = prefersReducedMotion();
  const n = faces.length;
  useEffect(() => {
    if (!auto || paused || hover || focusWithin || faces.length <= 1) return;
    const id = globalThis.window.setInterval(() => {
      onIndexChange((activeIndex + 1) % faces.length);
    }, intervalMs);
    return () => globalThis.window.clearInterval(id);
  }, [activeIndex, auto, paused, hover, focusWithin, faces.length, intervalMs, onIndexChange]);

  function handleBlur(event: FocusEvent<globalThis.HTMLDivElement>) {
    const next = event.relatedTarget as globalThis.Node | null;
    if (!event.currentTarget.contains(next)) setFocusWithin(false);
  }

  // 면 각도: 3면이면 120°씩. translateZ 반지름은 컨테이너 폭 추정으로 충분히 큰 값.
  const stepDeg = 360 / Math.max(1, n);
  const radius = 600; // px — 면 분리용. width 보다 크게 둬 면 겹침 방지.

  if (reduced) {
    // Cross-fade fallback
    return (
      <div
        className="relative"
        style={{ height }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocusCapture={() => setFocusWithin(true)}
        onBlurCapture={handleBlur}
      >
        {faces.map((f, i) => (
          <div
            key={f.key}
            aria-hidden={i !== activeIndex}
            inert={i !== activeIndex}
            className="absolute inset-0 overflow-y-auto transition-opacity duration-300"
            style={{
              opacity: i === activeIndex ? 1 : 0,
              pointerEvents: i === activeIndex ? "auto" : "none",
            }}
          >
            {f.node}
          </div>
        ))}
      </div>
    );
  }

  if (motion === "slide") {
    return (
      <div
        className="relative overflow-hidden"
        style={{ height }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocusCapture={() => setFocusWithin(true)}
        onBlurCapture={handleBlur}
      >
        {faces.map((face, index) => {
          const rawOffset = index - activeIndex;
          const offset =
            rawOffset > n / 2 ? rawOffset - n : rawOffset < -n / 2 ? rawOffset + n : rawOffset;
          return (
            <div
              key={face.key}
              aria-hidden={index !== activeIndex}
              inert={index !== activeIndex}
              className="absolute inset-0 overflow-y-auto transition-[transform,opacity] duration-500 ease-out"
              style={{
                transform: `translateX(${offset * 100}%)`,
                opacity: index === activeIndex ? 1 : 0,
                pointerEvents: index === activeIndex ? "auto" : "none",
              }}
            >
              {face.node}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div
      style={{ height, perspective: "1600px" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocusCapture={() => setFocusWithin(true)}
      onBlurCapture={handleBlur}
    >
      <div
        className="relative w-full h-full"
        style={{
          transformStyle: "preserve-3d",
          transition: "transform 520ms cubic-bezier(0.22,1,0.36,1)",
          transform: `translateZ(-${radius}px) rotateY(-${activeIndex * stepDeg}deg)`,
        }}
      >
        {faces.map((f, i) => (
          <div
            key={f.key}
            aria-hidden={i !== activeIndex}
            inert={i !== activeIndex}
            className="absolute inset-0 overflow-y-auto"
            style={{
              transform: `rotateY(${i * stepDeg}deg) translateZ(${radius}px)`,
              backfaceVisibility: "hidden",
              WebkitBackfaceVisibility: "hidden",
              pointerEvents: i === activeIndex ? "auto" : "none",
            }}
          >
            {f.node}
          </div>
        ))}
      </div>
    </div>
  );
}
