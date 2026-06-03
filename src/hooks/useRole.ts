import type { AppRole } from "@/types/models";
import { useAuthUser } from "./useAuthUser";

export const ROLE_ORDER: Record<AppRole, number> = {
  user: 0,
  team_leader: 1,
  manager: 2,
  admin: 3,
};

/// role 이 min 이상인지 (순수 함수 — 컴포넌트 밖/리스트 필터에서 사용).
export function roleAtLeast(role: AppRole, min: AppRole): boolean {
  return ROLE_ORDER[role] >= ROLE_ORDER[min];
}

/// 현재 사용자의 role 이 min 이상인지.
///   useRole('team_leader') → team_leader / manager / admin → true
export function useRole(min: AppRole): boolean {
  const { role } = useAuthUser();
  return roleAtLeast(role, min);
}

/// 현재 role 그대로 반환 (라벨 표시 등).
export function useCurrentRole(): AppRole {
  return useAuthUser().role;
}
