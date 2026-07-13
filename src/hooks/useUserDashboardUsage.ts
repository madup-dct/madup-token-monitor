import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CompanyLeaderboardEntry } from "@/hooks/useUsage";
import {
  fetchUserDailyAggregates,
  fetchUserHourly,
  type UserDailyAggregate,
  type UserHourlyAggregate,
} from "@/lib/user-dashboard-data";
import { fetchUserProfile } from "@/lib/teams";
import {
  buildUserDashboardUsage,
  type UserUsageDailyRange,
  type UserUsageGranularity,
} from "@/lib/user-dashboard-usage";
import type { UsageScope } from "@/lib/usage-sources";

interface UseUserDashboardUsageInput {
  id: string | undefined;
  passedEntry: CompanyLeaderboardEntry | null;
  scope: UsageScope;
  granularity: UserUsageGranularity;
  dailyRange: UserUsageDailyRange;
}

const HISTORY_DAYS = 365;
const EMPTY_DAILY: UserDailyAggregate[] = [];
const EMPTY_HOURLY: UserHourlyAggregate[] = [];

export function useUserDashboardUsage(input: UseUserDashboardUsageInput) {
  const profileQuery = useQuery({
    queryKey: ["profile_lookup", input.id],
    queryFn: () => fetchUserProfile(input.id!),
    enabled: !!input.id && !input.passedEntry,
  });
  const dailyQuery = useQuery({
    queryKey: ["user_daily_aggregates", input.id, HISTORY_DAYS],
    queryFn: () => fetchUserDailyAggregates(input.id!, HISTORY_DAYS),
    enabled: !!input.id,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  const hourlyQuery = useQuery({
    queryKey: ["user_hourly", input.id, 48],
    queryFn: () => fetchUserHourly(input.id!, 48),
    enabled: !!input.id && input.granularity === "hourly",
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  const daily = dailyQuery.data ?? EMPTY_DAILY;
  const hourly = hourlyQuery.data ?? EMPTY_HOURLY;
  const [nowMs, setNowMs] = useState<number>(Date.now);
  useEffect(() => {
    const timer = globalThis.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => globalThis.clearInterval(timer);
  }, []);
  const usage = useMemo(
    () =>
      buildUserDashboardUsage({
        daily,
        hourly,
        scope: input.scope,
        granularity: input.granularity,
        dailyRange: input.dailyRange,
        nowMs,
      }),
    [daily, hourly, input.scope, input.granularity, input.dailyRange, nowMs]
  );
  const profile = profileQuery.data;

  return {
    usage,
    displayName:
      input.passedEntry?.display_name ??
      profile?.slack_handle ??
      profile?.name ??
      profile?.email ??
      input.id ??
      "—",
    avatarUrl: input.passedEntry?.avatar_url ?? profile?.avatar_url ?? null,
    subEmail: profile?.email ?? null,
    usageError:
      dailyQuery.error ?? (input.granularity === "hourly" ? hourlyQuery.error : null) ?? null,
  };
}
