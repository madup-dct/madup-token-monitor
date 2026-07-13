import { Select } from "@/components/ui/Select";
import { USAGE_SCOPE_OPTIONS, type UsageScope } from "@/lib/usage-sources";
import type { AppRole } from "@/types/models";

const ROLE_OPTIONS: { value: AppRole; label: string }[] = [
  { value: "user", label: "user" },
  { value: "team_leader", label: "team_leader" },
  { value: "manager", label: "manager" },
  { value: "admin", label: "admin" },
];

interface UserDashboardHeaderProps {
  displayName: string;
  avatarUrl: string | null;
  subEmail: string | null;
  scope: UsageScope;
  onScopeChange: (scope: UsageScope) => void;
  canAssignRole: boolean;
  roleMessage: string | null;
  onAssignRole: (role: AppRole) => void;
  onBack: () => void;
}

export function UserDashboardHeader({
  displayName,
  avatarUrl,
  subEmail,
  scope,
  onScopeChange,
  canAssignRole,
  roleMessage,
  onAssignRole,
  onBack,
}: UserDashboardHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-4 mb-5 flex-wrap">
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onBack}
          aria-label="뒤로"
          title="뒤로"
          className="mc-icon-btn"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M10 12L6 8l4-4" />
          </svg>
        </button>
        {avatarUrl ? (
          <img src={avatarUrl} alt={displayName} className="w-10 h-10 rounded-full object-cover" />
        ) : (
          <div className="w-10 h-10 rounded-full bg-surface-2" />
        )}
        <div className="min-w-0">
          <h1 className="text-[22px] font-bold tracking-[-0.01em] text-text-primary leading-tight truncate">
            {displayName}의 대시보드
          </h1>
          <p className="text-[12px] text-text-tertiary mt-0.5">
            {subEmail ? `${subEmail} · ` : ""}최근 30일 KPI · 캐시 포함 처리량
          </p>
        </div>
      </div>

      <div className="flex items-start gap-4 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-text-tertiary">데이터 소스</span>
          <Select
            value={scope}
            onChange={(value) => onScopeChange(value as UsageScope)}
            options={[...USAGE_SCOPE_OPTIONS]}
            ariaLabel="토큰 데이터 소스"
          />
        </div>
        {canAssignRole ? (
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-text-tertiary">권한 부여</span>
              <Select
                value=""
                onChange={(value) => {
                  if (value) onAssignRole(value as AppRole);
                }}
                options={[{ value: "", label: "역할 선택…" }, ...ROLE_OPTIONS]}
                ariaLabel="권한 부여"
              />
            </div>
            {roleMessage ? (
              <span className="text-[10.5px] text-text-tertiary max-w-[220px] text-right">
                {roleMessage}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
