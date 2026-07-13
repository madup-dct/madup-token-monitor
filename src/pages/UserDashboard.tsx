import { useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  useUserMcp,
  useUserPlugins,
  useUserTools,
  type CompanyLeaderboardEntry,
} from "@/hooks/useUsage";
import { useRole } from "@/hooks/useRole";
import { useUserDashboardUsage } from "@/hooks/useUserDashboardUsage";
import { assignAppRole } from "@/lib/teams";
import { usePersistentState } from "@/lib/usePersistentState";
import { USAGE_SCOPE_OPTIONS, isUsageScope, type UsageScope } from "@/lib/usage-sources";
import type { UserUsageDailyRange, UserUsageGranularity } from "@/lib/user-dashboard-usage";
import { UserDashboardHeader } from "@/components/dashboard/user/UserDashboardHeader";
import { UserUsageOverview } from "@/components/dashboard/user/UserUsageOverview";
import { UserUsageDetails } from "@/components/dashboard/user/UserUsageDetails";
import type { AppRole } from "@/types/models";

interface NavState {
  entry?: CompanyLeaderboardEntry;
  rangeDays?: number;
  periodLabel?: string;
}

export default function UserDashboard() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const state = (location.state ?? {}) as NavState;
  const passedEntry = state.entry ?? null;
  const [scope, setScope] = usePersistentState<UsageScope>(
    "madup-token-monitor:view:user:usageSource",
    "combined",
    isUsageScope
  );
  const [granularity, setGranularity] = usePersistentState<UserUsageGranularity>(
    "madup-token-monitor:view:user:granularity",
    "daily"
  );
  const [dailyRange, setDailyRange] = usePersistentState<UserUsageDailyRange>(
    "madup-token-monitor:view:user:dailyRange",
    30
  );
  const [metric, setMetric] = usePersistentState<"tokens" | "cost">(
    "madup-token-monitor:view:user:metric",
    "tokens"
  );
  const [view, setView] = usePersistentState<"chart" | "list">(
    "madup-token-monitor:view:user:view",
    "chart"
  );
  const dashboard = useUserDashboardUsage({
    id,
    passedEntry,
    scope,
    granularity,
    dailyRange,
  });
  const mcp = useUserMcp(id ?? null, 30);
  const plugins = useUserPlugins(id ?? null, 30);
  const tools = useUserTools(id ?? null, 30);
  const isAdmin = useRole("admin");
  const [roleMessage, setRoleMessage] = useState<string | null>(null);
  const scopeLabel = USAGE_SCOPE_OPTIONS.find((option) => option.value === scope)?.label ?? "통합";

  async function handleAssignRole(role: AppRole) {
    if (!id) return;
    setRoleMessage(null);
    try {
      await assignAppRole(id, role);
      setRoleMessage(`권한을 ${role} 로 설정했습니다.`);
    } catch {
      setRoleMessage("권한 부여에 실패했습니다. 잠시 후 다시 시도해 주세요.");
    }
  }

  function copyToClipboard() {
    const lines = [
      ["Source", scopeLabel].join("\t"),
      ["Period", metric === "tokens" ? "Tokens" : "Cost (USD)"].join("\t"),
      ...dashboard.usage.rows.map((row) =>
        [
          dashboard.usage.labelFormat(row),
          metric === "tokens" ? row.tokens : row.cost.toFixed(4),
        ].join("\t")
      ),
    ];
    globalThis.navigator.clipboard.writeText(lines.join("\n")).catch(() => {});
  }

  return (
    <div className="px-7 pt-5 pb-8">
      <UserDashboardHeader
        displayName={dashboard.displayName}
        avatarUrl={dashboard.avatarUrl}
        subEmail={dashboard.subEmail}
        scope={scope}
        onScopeChange={setScope}
        canAssignRole={isAdmin && !!id}
        roleMessage={roleMessage}
        onAssignRole={handleAssignRole}
        onBack={() => navigate(-1)}
      />

      {dashboard.usageError ? (
        <div
          role="alert"
          className="mb-4 rounded-[10px] border border-coral/30 bg-coral/10 px-3.5 py-2.5 text-[12px] text-coral"
        >
          사용량을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.
        </div>
      ) : null}

      <div className="grid grid-cols-12 gap-4">
        <UserUsageOverview usage={dashboard.usage} scopeLabel={scopeLabel} />
        <UserUsageDetails
          usage={dashboard.usage}
          scopeLabel={scopeLabel}
          granularity={granularity}
          dailyRange={dailyRange}
          metric={metric}
          view={view}
          onGranularityChange={setGranularity}
          onDailyRangeChange={setDailyRange}
          onMetricChange={setMetric}
          onViewChange={setView}
          onCopy={copyToClipboard}
          mcp={{ data: mcp.data ?? [], error: mcp.error, isLoading: mcp.isLoading }}
          plugins={{
            data: plugins.data ?? [],
            error: plugins.error,
            isLoading: plugins.isLoading,
          }}
          tools={{ data: tools.data ?? [], error: tools.error, isLoading: tools.isLoading }}
        />
      </div>

      <p className="text-[12px] text-text-secondary mt-5 pt-3 border-t border-hairline">
        토큰·비용·활동 뷰는 선택한 소스의 캐시 포함 처리량입니다. MCP·플러그인·도구는 Claude
        기록이며, 본인 전용 OAuth 한도·세션·기기 데이터는 집계에 포함되지 않습니다.
      </p>
    </div>
  );
}
