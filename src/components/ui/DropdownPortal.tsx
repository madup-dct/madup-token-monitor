import {
  useLayoutEffect,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

interface DropdownPortalProps {
  /// 위치 기준이 되는 트리거 엘리먼트 ref (버튼/인풋 등).
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  children: ReactNode;
  /// 트리거의 left 모서리 기준(left) 또는 right 모서리 기준(right) 정렬. 기본 left.
  align?: "left" | "right";
  /// 트리거와 메뉴 사이 간격(px). 기본 4.
  gap?: number;
  /// 메뉴 최소 너비를 트리거 너비에 맞춤. 기본 true.
  matchWidth?: boolean;
  className?: string;
  style?: CSSProperties;
  role?: string;
  /// 외부 클릭 판정을 위해 부모가 메뉴 DOM 을 참조할 ref.
  menuRef?: RefObject<HTMLDivElement | null>;
}

/// 드롭다운 메뉴를 document.body 로 portal 해 fixed 로 띄운다.
/// 트리거의 위치(getBoundingClientRect)에 앵커링 — 부모의 overflow:hidden(예: mc-card)에
/// 잘리지 않는다. 스크롤/리사이즈 시 위치 재계산. z-index 200 (Modal z-100 위).
export function DropdownPortal({
  anchorRef,
  open,
  children,
  align = "left",
  gap = 4,
  matchWidth = true,
  className = "",
  style,
  role,
  menuRef,
}: DropdownPortalProps) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setRect(null);
      return;
    }
    const update = () => {
      const el = anchorRef.current;
      if (el) setRect(el.getBoundingClientRect());
    };
    update();
    // capture=true 로 내부 스크롤 컨테이너 스크롤도 잡는다.
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, anchorRef]);

  if (!open || !rect) return null;

  const pos: CSSProperties = {
    position: "fixed",
    top: rect.bottom + gap,
    zIndex: 200,
    ...(matchWidth ? { minWidth: rect.width } : {}),
    ...(align === "right"
      ? { right: Math.max(8, window.innerWidth - rect.right) }
      : { left: rect.left }),
  };

  return createPortal(
    <div ref={menuRef} role={role} style={{ ...pos, ...style }} className={className}>
      {children}
    </div>,
    document.body,
  );
}
