import { supabase } from "@/lib/supabase";

export interface UserDailyAggregate {
  date: string;
  source: string;
  total_input: number;
  total_output: number;
  total_tokens: number;
  total_cost_usd: number;
}

export interface UserHourlyAggregate {
  hour_utc: string;
  source: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
  request_count: number;
}

const PAGE_SIZE = 1_000;
const DAY_MS = 24 * 3_600_000;
const KST_OFFSET_MS = 9 * 3_600_000;

function kstDateKey(timestamp: number): string {
  const date = new Date(timestamp + KST_OFFSET_MS);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export async function fetchUserDailyAggregates(
  userId: string,
  days: number
): Promise<UserDailyAggregate[]> {
  if (!userId || days <= 0) return [];
  const startKey = kstDateKey(Date.now() - (days - 1) * DAY_MS);
  const rows: UserDailyAggregate[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("usage_aggregates")
      .select("date, source, total_input, total_output, total_tokens, total_cost_usd")
      .eq("user_id", userId)
      .gte("date", startKey)
      .order("date", { ascending: true })
      .order("source", { ascending: true })
      .order("device_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as UserDailyAggregate[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

export async function fetchUserHourly(userId: string, hours = 48): Promise<UserHourlyAggregate[]> {
  if (!userId || hours <= 0) return [];
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const rows: UserHourlyAggregate[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("usage_hourly")
      .select(
        "hour_utc, source, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, request_count"
      )
      .eq("user_id", userId)
      .gte("hour_utc", since)
      .order("hour_utc", { ascending: true })
      .order("source", { ascending: true })
      .order("model", { ascending: true })
      .order("device_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as UserHourlyAggregate[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}
