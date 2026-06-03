import { useSearchParams } from "react-router-dom";
import { useCurrentRole, roleAtLeast } from "@/hooks/useRole";
import { CrossTeamPanel } from "@/components/team/CrossTeamPanel";
import { TeamManageList } from "@/components/team/TeamManageList";
import { UserDirectory } from "@/components/team/UserDirectory";

/// 사이드바 "팀 관리" — 유저 검색/디렉토리 + 타팀 비교 + 팀 목록/드릴다운.
/// 팀 드릴다운(?team=:id) 진입 시엔 TeamManageList(상세)만 노출해 화면을 정리.
/// team_leader 이상만 접근.
export default function TeamManage() {
  const role = useCurrentRole();
  const [params] = useSearchParams();
  const drilled = !!params.get("team");

  if (!roleAtLeast(role, "team_leader")) {
    return (
      <div className="px-7 pt-5 pb-8">
        <div className="mc-card p-8 text-center text-text-tertiary text-[13px]">
          팀 관리는 팀 리더 이상만 접근할 수 있습니다.
        </div>
      </div>
    );
  }

  return (
    <div className="px-7 pt-5 pb-8 flex flex-col gap-6">
      {drilled ? (
        <TeamManageList />
      ) : (
        <>
          <CrossTeamPanel />
          <UserDirectory />
          <TeamManageList />
        </>
      )}
    </div>
  );
}
