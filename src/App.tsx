import { useEffect, useRef } from "react";
import { BrowserRouter, Routes, Route, useNavigate } from "react-router-dom";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { onOpenUrl, getCurrent } from "@tauri-apps/plugin-deep-link";
import "@/i18n/index";
import { Dashboard } from "@/pages/Dashboard";
import CompanyDashboard from "@/pages/CompanyDashboard";
import TeamMy from "@/pages/TeamMy";
import TeamManage from "@/pages/TeamManage";
import AdminAnalytics from "@/pages/AdminAnalytics";
import Settings from "@/pages/Settings";
import Login from "@/pages/Login";
import UserDashboard from "@/pages/UserDashboard";
import { AuthGuard } from "@/lib/AuthGuard";
import { handleAuthCallback, syncAggregatesNow } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { Sidebar } from "@/components/layout/Sidebar";
import { TitleBar } from "@/components/layout/TitleBar";

// 캐시를 localStorage에 영속화 — 앱 재시작 시 옛 데이터를 즉시 표시하고 백그라운드 refetch.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 1000 * 60 * 60 * 24, // 24h: persist 대상이 되려면 gcTime이 충분히 길어야 함
      staleTime: 1000 * 30,
    },
  },
});

const persister = createSyncStoragePersister({
  storage: typeof window !== "undefined" ? window.localStorage : undefined,
  key: "madup-token-monitor:rq",
});

function Layout() {
  return (
    <AuthGuard>
      <div className="flex flex-col h-screen overflow-hidden bg-canvas text-text-primary">
        <TitleBar />
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <Sidebar />
          <main className="flex-1 overflow-y-auto min-w-0">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/team" element={<TeamMy />} />
              <Route path="/team/company" element={<CompanyDashboard />} />
              <Route path="/team/manage" element={<TeamManage />} />
              <Route path="/team/admin" element={<AdminAnalytics />} />
              <Route path="/user/:id" element={<UserDashboard />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </main>
        </div>
      </div>
    </AuthGuard>
  );
}

/// 로그인 시 1시간마다 사내 집계 sync. 모니터링 목적이라 opt-in 없이 항상 공유.
function AggregateSyncDriver() {
  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | undefined;

    async function runOnce() {
      if (cancelled) return;
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const userId = sessionData.session?.user.id;
        if (!userId) return;
        await syncAggregatesNow();
      } catch (e) {
        console.warn("[aggregate-sync] failed:", e);
      }
    }

    const initial = setTimeout(runOnce, 5_000);
    interval = setInterval(runOnce, 60 * 60 * 1000);

    return () => {
      cancelled = true;
      clearTimeout(initial);
      if (interval) clearInterval(interval);
    };
  }, []);
  return null;
}

/// 키보드 단축키:
///   - ⌘W (mac) / Ctrl+W (win/linux) → 윈도우 hide (트레이로 복귀)
/// `decorations:false` 라 native menu accelerator 가 없으므로 JS 에서 직접 처리.
function KeyboardShortcuts() {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "w" || e.key === "W")) {
        e.preventDefault();
        // Tauri 외부(웹 미리보기) 에서는 무시.
        if (!("__TAURI_INTERNALS__" in window)) return;
        getCurrentWindow().close().catch(() => {});
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return null;
}

/// 인증 첫 체크가 끝나면 윈도우를 표시.
/// `tauri.conf.json` 에서 visible:false 로 띄운 뒤, AuthGuard 가 결정한 첫 paint
/// (Login or Dashboard) 가 준비됐을 때만 show() → "Dashboard 가 잠깐 보였다가
/// Login 으로 이동하는" 깜빡임 제거.
function ShowWindowOnReady() {
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let shown = false;
    function showOnce() {
      if (shown) return;
      shown = true;
      const w = getCurrentWindow();
      w.show().catch(() => {});
      w.setFocus().catch(() => {});
    }
    // 인증 체크 완료 후 show.
    supabase.auth.getSession().finally(showOnce);
    // 안전망: 1.2 초 안에 무조건 show (네트워크 hang 등으로 getSession 이 늦게 도착해도
    // 사용자가 빈 macOS dock 만 보는 일은 없게).
    const safety = setTimeout(showOnce, 1200);
    return () => clearTimeout(safety);
  }, []);
  return null;
}

function DeepLinkBridge() {
  const navigate = useNavigate();
  // navigate ref 우회 + deps=[] — 라우트 변경마다 재실행되지 않도록.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const processed = new Set<string>();

    async function processUrl(url: string | null | undefined) {
      console.info("[deep-link] processUrl received:", url);
      if (!url || !url.startsWith("madup-token-monitor://auth/callback")) {
        console.info("[deep-link] skipping (no match)");
        return;
      }
      if (processed.has(url)) {
        console.info("[deep-link] already processed");
        return;
      }
      processed.add(url);
      invoke("show_main_window").catch(() => {});
      const ok = await handleAuthCallback(url);
      console.info("[deep-link] handleAuthCallback ->", ok);
      if (ok) navigateRef.current("/", { replace: true });
    }

    getCurrent()
      .then((urls) => {
        console.info("[deep-link] getCurrent on mount:", urls);
        processUrl(urls?.[0]);
      })
      .catch((e) => console.warn("[deep-link] getCurrent failed:", e));

    onOpenUrl((urls) => {
      console.info("[deep-link] onOpenUrl event:", urls);
      processUrl(urls?.[0]);
    })
      .then((u) => {
        console.info("[deep-link] onOpenUrl listener registered");
        unlisten = u;
      })
      .catch((e) => console.warn("[deep-link] onOpenUrl register failed:", e));

    return () => unlisten?.();
  }, []);
  return null;
}

export default function App() {
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{ persister, maxAge: 1000 * 60 * 60 * 24 * 7 }}
    >
      <BrowserRouter>
        <KeyboardShortcuts />
        <ShowWindowOnReady />
        <DeepLinkBridge />
        <AggregateSyncDriver />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/*" element={<Layout />} />
        </Routes>
      </BrowserRouter>
    </PersistQueryClientProvider>
  );
}
