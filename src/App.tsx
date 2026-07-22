import { useEffect, useRef } from "react";
import { BrowserRouter, Routes, Route, useNavigate } from "react-router-dom";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
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
import AccountLimits from "@/pages/AccountLimits";
import Settings from "@/pages/Settings";
import Login from "@/pages/Login";
import UserDashboard from "@/pages/UserDashboard";
import { AuthGuard } from "@/lib/AuthGuard";
import { clearSessionInRust, handleAuthCallback, pushSessionToRust, syncAggregatesNow } from "@/lib/auth";
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
              <Route path="/limits" element={<AccountLimits />} />
              <Route path="/user/:id" element={<UserDashboard />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </main>
        </div>
      </div>
    </AuthGuard>
  );
}

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 주기 sync (기존 1h → 단축). 변경 즉시 반영은 usage-updated 이벤트가 담당.
const EVENT_SYNC_THROTTLE_MS = 60_000; // 증분 sync 로 페이로드는 작지만 요청 빈도 자체를 낮춤. 트레이 실시간성은 로컬 경로 담당.

/// 로그인 시 주기 + 변경 이벤트 기반 사내 집계 sync. 모니터링 목적이라 opt-in 없이 항상 공유.
/// watcher 가 새 사용량을 SQLite 에 쓰면 'usage-updated' 이벤트를 emit → 여기서 throttle 후
/// syncAggregatesNow + 본인 쿼리 invalidate → 화면/트레이가 수초 내 갱신.
function AggregateSyncDriver() {
  const qc = useQueryClient();
  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    let trailing: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;
    let lastRun = 0;
    let syncing = false; // 재진입 가드 — 전체 재업로드가 throttle 창보다 길어도 중복 실행 방지.

    function invalidateMine() {
      // 본인 사용량 파생 쿼리 — 동기화 후 즉시 refetch.
      // my_hourly: 캐러셀 자동회전으로 상시 fetch 되면서 mount 후 갱신 트리거가
      // 이것뿐이라 누락 시 시간별 면이 오래된 차트로 고정된다.
      for (const key of ["summary", "timeseries", "heatmap", "my_device_count", "my_hourly"]) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    }

    async function runOnce() {
      if (cancelled || syncing) return;
      syncing = true;
      lastRun = Date.now();
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const userId = sessionData.session?.user.id;
        if (userId) await syncAggregatesNow();
      } catch (e) {
        console.warn("[aggregate-sync] failed:", e);
      } finally {
        syncing = false;
        // sync 실패/비로그인과 무관하게 항상 invalidate — summary 등 로컬 SQLite
        // 기반 쿼리가 업로드 실패에 인질로 잡혀 옛 숫자에 고정되는 것을 방지.
        if (!cancelled) invalidateMine();
      }
    }

    // usage-updated → leading+trailing throttle (최소 EVENT_SYNC_THROTTLE_MS 간격).
    function onUsageUpdated() {
      const elapsed = Date.now() - lastRun;
      if (elapsed >= EVENT_SYNC_THROTTLE_MS) {
        runOnce();
      } else if (!trailing) {
        trailing = setTimeout(() => {
          trailing = undefined;
          runOnce();
        }, EVENT_SYNC_THROTTLE_MS - elapsed);
      }
    }

    const initial = setTimeout(runOnce, 5_000);
    interval = setInterval(runOnce, SYNC_INTERVAL_MS);

    // Tauri 환경에서만 이벤트 구독 (웹 미리보기엔 watcher 없음).
    // window-shown: 팝오버 webview 는 visibilitychange 가 발화하지 않아
    // refetchOnWindowFocus 를 못 쓴다 — 트레이가 열리는 순간 같은 throttle 경로로
    // sync+invalidate 해 "열었는데 옛 숫자" 상태를 해소한다.
    if ("__TAURI_INTERNALS__" in window) {
      import("@tauri-apps/api/event")
        .then(({ listen }) =>
          Promise.all([
            listen("usage-updated", onUsageUpdated),
            listen("window-shown", onUsageUpdated),
          ])
        )
        .then((uns) => {
          if (cancelled) uns.forEach((un) => un());
          else unlisten = () => uns.forEach((un) => un());
        })
        .catch((e) => console.warn("[usage-updated] listen failed:", e));
    }

    return () => {
      cancelled = true;
      clearTimeout(initial);
      if (interval) clearInterval(interval);
      if (trailing) clearTimeout(trailing);
      unlisten?.();
    };
  }, [qc]);
  return null;
}

/// Rust 트레이가 타기기 오늘 비용을 Supabase 에서 조회할 수 있도록 세션(JWT)을
/// Rust 메모리 캐시로 전달. Rust 는 세션을 영속하지 않으므로 앱 시작 1회 +
/// SIGNED_IN/TOKEN_REFRESHED(자동 갱신은 JS 에서만 발생)마다 다시 밀어넣는다.
function SupabaseSessionBridge() {
  useEffect(() => {
    void pushSessionToRust();
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        void pushSessionToRust(session);
      } else if (event === "SIGNED_OUT") {
        // 이전 사용자 JWT/비용이 Rust 메모리·트레이에 잔류하지 않게 즉시 제거.
        void clearSessionInRust();
      }
    });
    return () => data.subscription.unsubscribe();
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
        <SupabaseSessionBridge />
        <AggregateSyncDriver />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/*" element={<Layout />} />
        </Routes>
      </BrowserRouter>
    </PersistQueryClientProvider>
  );
}
