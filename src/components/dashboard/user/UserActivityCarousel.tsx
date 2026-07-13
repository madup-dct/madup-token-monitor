import { CarouselCard } from "@/components/dashboard/CarouselCard";
import { HeatMap } from "@/components/HeatMap";
import { RankBarList } from "@/components/ui/RankBarList";
import { prettyToolName } from "@/lib/labels";
import type { McpUsage, PluginUsage } from "@/types/models";
import type { UserToolRow } from "@/hooks/useUsage";

interface UsageList<T> {
  data: readonly T[];
  error: Error | null;
  isLoading: boolean;
}

interface UserActivityCarouselProps {
  scopeLabel: string;
  heatmapData: { date: string; count: number; cost_usd: number }[];
  mcp: UsageList<McpUsage>;
  plugins: UsageList<PluginUsage>;
  tools: UsageList<UserToolRow>;
}

function ErrorMessage({ error }: { error: Error | null }) {
  return error ? (
    <div className="text-[12px] text-coral mb-2 px-1">사용량을 불러오지 못했습니다.</div>
  ) : null;
}

export function UserActivityCarousel({
  scopeLabel,
  heatmapData,
  mcp,
  plugins,
  tools,
}: UserActivityCarouselProps) {
  return (
    <CarouselCard
      persistKey="madup-token-monitor:view:user:carousel"
      className="col-span-4 max-[1339px]:col-span-12"
      height={320}
      faces={[
        {
          key: "heatmap",
          title: "활동",
          subtitle: (
            <>
              <span className="max-[1339px]:hidden">{scopeLabel} · 최근 8주 토큰 강도</span>
              <span className="hidden max-[1339px]:inline">{scopeLabel} · 최근 6주 토큰 강도</span>
            </>
          ),
          node: (
            <div className="h-full">
              <div className="max-[1339px]:hidden">
                <HeatMap data={heatmapData} weeks={8} unitLabel="tokens" />
              </div>
              <div className="hidden max-[1339px]:block max-[1339px]:w-fit max-[1339px]:mx-auto">
                <HeatMap data={heatmapData} weeks={6} unitLabel="tokens" />
              </div>
            </div>
          ),
        },
        {
          key: "mcp",
          title: "MCP 사용량",
          subtitle: "30일 · Claude",
          node: (
            <div className="h-full pr-1">
              <ErrorMessage error={mcp.error} />
              <RankBarList
                items={mcp.data.map((item) => ({
                  label: item.mcp_server,
                  value: Number(item.count),
                }))}
                formatValue={(value) => value.toLocaleString("ko-KR")}
                emptyMessage={mcp.isLoading ? "로딩 중…" : "MCP 사용 기록 없음 (최근 30일)"}
              />
            </div>
          ),
        },
        {
          key: "plugins",
          title: "플러그인 사용량",
          subtitle: "30일 · Claude",
          node: (
            <div className="h-full pr-1">
              <ErrorMessage error={plugins.error} />
              <RankBarList
                items={plugins.data.map((item) => ({
                  label: item.plugin_id,
                  value: Number(item.count),
                }))}
                formatValue={(value) => value.toLocaleString("ko-KR")}
                emptyMessage={
                  plugins.isLoading ? "로딩 중…" : "플러그인 사용 기록 없음 (최근 30일)"
                }
              />
            </div>
          ),
        },
        {
          key: "tools",
          title: "도구 사용량",
          subtitle: "30일 · Claude",
          node: (
            <div className="h-full pr-1">
              <ErrorMessage error={tools.error} />
              <RankBarList
                items={tools.data.map((item) => ({
                  label: prettyToolName(item.tool_name),
                  value: item.count,
                }))}
                formatValue={(value) => value.toLocaleString("ko-KR")}
                emptyMessage={tools.isLoading ? "로딩 중…" : "도구 사용 기록 없음 (최근 30일)"}
              />
            </div>
          ),
        },
      ]}
    />
  );
}
