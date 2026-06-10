import type { ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuthUser } from "@/hooks/useAuthUser";
import { roleAtLeast } from "@/hooks/useRole";
import { signOut } from "@/lib/supabase";
import { UpdateNotifier } from "@/components/UpdateNotifier";
import type { AppRole } from "@/types/models";

const ROLE_LABEL: Record<AppRole, string | null> = {
  user: null,
  team_leader: "리더",
  manager: "매니저",
  admin: "어드민",
};

const ROLE_BADGE_TONE: Record<AppRole, string> = {
  user: "",
  team_leader: "bg-azure-soft text-azure-bright",
  manager: "bg-azure-soft text-azure-bright",
  admin: "bg-azure-soft text-azure-bright",
};

interface NavItemDef {
  to: string;
  end?: boolean;
  labelKey: string;
  group: "personal" | "team";
  /// 이 권한 이상만 노출 (미지정 = 전원).
  minRole?: AppRole;
  icon: ReactNode;
}

const NAV_ITEMS: NavItemDef[] = [
  {
    to: "/",
    end: true,
    labelKey: "nav.dashboard",
    group: "personal",
    icon: (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <rect x="2" y="2" width="5" height="6" rx="1.2" />
        <rect x="9" y="2" width="5" height="4" rx="1.2" />
        <rect x="2" y="10" width="5" height="4" rx="1.2" />
        <rect x="9" y="8" width="5" height="6" rx="1.2" />
      </svg>
    ),
  },
  {
    to: "/team",
    end: true,
    labelKey: "nav.teamMy",
    group: "team",
    icon: (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="6" cy="6" r="2.3" />
        <path d="M2 13.5a4 4 0 018 0" />
        <path d="M11 4.2a2.2 2.2 0 010 4.1" />
        <path d="M12 13.5a4 4 0 00-2-3.4" />
      </svg>
    ),
  },
  {
    to: "/team/company",
    labelKey: "nav.teamCompany",
    group: "team",
    minRole: "admin",
    icon: (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      >
        <rect x="3" y="2.5" width="10" height="11" rx="1" />
        <path d="M6 5.5h1.5M9 5.5h1M6 8h1.5M9 8h1M6 10.5h1.5M9 10.5h1" />
      </svg>
    ),
  },
  {
    to: "/team/manage",
    labelKey: "nav.teamManage",
    group: "team",
    minRole: "team_leader",
    icon: (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      >
        <path d="M2 5h7M11.5 5H14M2 11h2.5M7 11h7" />
        <circle cx="10" cy="5" r="1.6" />
        <circle cx="5.5" cy="11" r="1.6" />
      </svg>
    ),
  },
  {
    to: "/team/admin",
    labelKey: "nav.teamAdmin",
    group: "team",
    minRole: "manager",
    icon: (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2 14h12" />
        <rect x="3" y="8" width="2.4" height="4" rx="0.5" />
        <rect x="6.8" y="5" width="2.4" height="7" rx="0.5" />
        <rect x="10.6" y="2.5" width="2.4" height="9.5" rx="0.5" />
      </svg>
    ),
  },
];

function initials(text: string | undefined | null) {
  if (!text) return "?";
  const trimmed = text.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}

export function Sidebar() {
  const { t } = useTranslation();
  const { user, role } = useAuthUser();
  const navigate = useNavigate();
  const location = useLocation();
  const settingsActive = location.pathname.startsWith("/settings");
  const roleLabel = ROLE_LABEL[role];
  const roleBadgeTone = ROLE_BADGE_TONE[role];

  async function handleSignOut() {
    await signOut();
    navigate("/login", { replace: true });
  }

  return (
    <aside
      className="w-56 shrink-0 flex flex-col gap-5 border-r border-hairline px-3 py-5 bg-[rgba(7,11,23,0.55)]"
    >
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-2 pb-2">
        <div
          className="w-7 h-7 rounded-md flex items-center justify-center text-white font-extrabold text-[13px] tracking-tight"
          style={{
            background:
              "linear-gradient(135deg, var(--color-azure-bright) 0%, var(--color-azure-deep) 100%)",
            boxShadow:
              "inset 0 1px 0 rgba(255,255,255,0.2), 0 4px 14px rgba(77,163,255,0.35)",
          }}
        >
          M
        </div>
        <div className="flex flex-col leading-tight">
          <span className="font-bold text-[13px] text-text-primary tracking-[0.04em]">
            MADUP
          </span>
          <span className="text-[10px] text-text-tertiary tracking-[0.18em] uppercase mt-0.5">
            Token Console
          </span>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-0.5">
        <div className="text-[10.5px] font-bold tracking-[0.16em] uppercase text-text-faint px-3 pt-1 pb-2 whitespace-nowrap">
          Personal
        </div>
        {NAV_ITEMS.filter((i) => i.group === "personal").map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `mc-nav-item ${isActive ? "active" : ""}`
            }
          >
            <span className="w-4 h-4 shrink-0 text-text-tertiary [.active_&]:text-azure">
              {item.icon}
            </span>
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">
              {t(item.labelKey)}
            </span>
          </NavLink>
        ))}

        <div className="text-[10.5px] font-bold tracking-[0.16em] uppercase text-text-faint px-3 pt-3.5 pb-2 whitespace-nowrap">
          Team
        </div>
        {NAV_ITEMS.filter(
          (i) => i.group === "team" && roleAtLeast(role, i.minRole ?? "user"),
        ).map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `mc-nav-item ${isActive ? "active" : ""}`
            }
          >
            <span className="w-4 h-4 shrink-0 text-text-tertiary [.active_&]:text-azure">
              {item.icon}
            </span>
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">
              {t(item.labelKey)}
            </span>
          </NavLink>
        ))}
      </nav>

      <div className="flex-1" />

      <UpdateNotifier />

      <div className="h-px bg-hairline mx-1" />

      {/* User block */}
      {user ? (
        <div className="grid grid-cols-[32px_1fr_auto] gap-2.5 items-center p-2 rounded-lg bg-surface-1 border border-hairline">
          {user.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt={user.name ?? user.email}
              className="w-8 h-8 rounded-full object-cover"
            />
          ) : (
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold"
              style={{
                background:
                  "linear-gradient(135deg, #4da3ff 0%, #b68cff 100%)",
                color: "#06122b",
              }}
            >
              {initials(user.name ?? user.email)}
            </div>
          )}
          <div className="min-w-0">
            <div className="text-[12px] font-semibold text-text-primary leading-tight truncate">
              {user.name ?? user.email}
            </div>
            <div className="flex items-center gap-1.5 min-w-0 mt-0.5">
              {roleLabel ? (
                <span
                  className={`shrink-0 text-[9px] font-bold tracking-[0.08em] uppercase rounded px-1.5 py-px leading-[1.6] ${roleBadgeTone}`}
                  title={`권한: ${roleLabel}`}
                >
                  {roleLabel}
                </span>
              ) : null}
              <span className="text-[11px] text-text-tertiary leading-tight truncate">
                {user.email}
              </span>
            </div>
          </div>
          <div className="flex gap-0.5">
            <button
              type="button"
              onClick={() => navigate("/settings")}
              aria-label="설정"
              title="설정"
              className={`mc-icon-btn ${settingsActive ? "bg-azure-soft text-azure-bright" : ""}`}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={handleSignOut}
              aria-label="로그아웃"
              title="로그아웃"
              className="mc-icon-btn"
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
            </button>
          </div>
        </div>
      ) : (
        <div className="p-2 rounded-lg bg-surface-1 border border-hairline">
          <div className="text-[11px] text-text-tertiary truncate">
            로그인 필요
          </div>
        </div>
      )}
    </aside>
  );
}
