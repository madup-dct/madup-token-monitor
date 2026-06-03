import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fetchMyRole, fetchMyTeamIds } from "@/lib/teams";
import type { AppRole } from "@/types/models";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  slackHandle: string | null;
}

function deriveUser(u: { id: string; email?: string | null; user_metadata?: Record<string, unknown> } | null): AuthUser | null {
  if (!u) return null;
  const meta = u.user_metadata ?? {};
  const name =
    (meta.full_name as string | undefined) ??
    (meta.name as string | undefined) ??
    (u.email ? u.email.split("@")[0] : "");
  const avatarUrl =
    (meta.avatar_url as string | undefined) ??
    (meta.picture as string | undefined) ??
    null;
  const slackHandle =
    (meta.slack_handle as string | undefined) ??
    (meta.user_name as string | undefined) ??
    null;
  return {
    id: u.id,
    email: u.email ?? "",
    name,
    avatarUrl,
    slackHandle,
  };
}

export function useAuthUser() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<AppRole>("user");
  const [myTeamIds, setMyTeamIds] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function loadRoleAndTeams() {
      try {
        const [r, ids] = await Promise.all([fetchMyRole(), fetchMyTeamIds()]);
        if (cancelled) return;
        setRole(r);
        setMyTeamIds(ids);
      } catch {
        if (cancelled) return;
        setRole("user");
        setMyTeamIds([]);
      }
    }

    supabase.auth.getUser().then(({ data }) => {
      if (cancelled) return;
      const u = deriveUser(data.user);
      setUser(u);
      setLoading(false);
      if (u) loadRoleAndTeams();
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      const u = deriveUser(session?.user ?? null);
      setUser(u);
      if (u) {
        loadRoleAndTeams();
      } else {
        setRole("user");
        setMyTeamIds([]);
      }
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  return { user, loading, role, myTeamIds };
}
