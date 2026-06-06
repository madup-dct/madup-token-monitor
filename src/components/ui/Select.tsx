import { useEffect, useRef, useState } from "react";
import { DropdownPortal } from "./DropdownPortal";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  ariaLabel?: string;
  className?: string;
}

export function Select({
  value,
  onChange,
  options,
  ariaLabel,
  className = "",
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      const t = e.target as Node;
      if (!buttonRef.current?.contains(t) && !popoverRef.current?.contains(t)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div className={`relative inline-block ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="mc-select"
      >
        <span>{selected?.label ?? value}</span>
        <svg
          width="9"
          height="9"
          viewBox="0 0 12 12"
          className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        >
          <path
            d="M3 4.5 L6 7.5 L9 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <DropdownPortal
        anchorRef={buttonRef}
        open={open}
        menuRef={popoverRef}
        role="listbox"
        className="rounded-md border border-hairline overflow-hidden"
        style={{
          background: "var(--color-surface-2)",
          boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        }}
      >
        {options.map((opt) => {
            const active = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`block w-full text-left px-3 py-2 text-[12px] font-medium whitespace-nowrap transition-colors ${
                  active
                    ? "bg-azure-soft text-azure-bright"
                    : "text-text-secondary hover:text-text-primary hover:bg-surface-3"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
      </DropdownPortal>
    </div>
  );
}
