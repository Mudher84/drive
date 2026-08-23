import React, { useState, useEffect, Suspense } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthWizard } from "./components/shared/AuthWizard";
import { ErrorBoundary } from "./components/shared/ErrorBoundary";
import { UpdateBanner } from "./components/shared/UpdateBanner";
import { useUpdateCheck } from "./hooks/useUpdateCheck";
import { usePlatform } from "./hooks/usePlatform";
import "./App.css";

const DesktopDashboard = React.lazy(() => import("./components/desktop/DesktopDashboard").then(m => ({ default: m.Dashboard })));
// Vite requires a fully static import path for dynamic imports so it can
// perform static analysis and code-splitting. Template literals with
// variables prevent Vite from resolving the module at build time.
const MobileDashboard = React.lazy(() => import("./components/mobile/MobileDashboard.tsx"));
const DesignGallery = import.meta.env.DEV
  ? React.lazy(() => import("./components/dev/DesignGallery"))
  : null;

import { Toaster } from "sonner";
import { ConfirmProvider } from "./context/ConfirmContext";
import { ThemeProvider, useTheme } from "./context/ThemeContext";
import { SettingsProvider } from "./context/SettingsContext";
import { EncryptionProvider } from "./hooks/useEncryption.tsx";
import { useSettings } from "./context/SettingsContext";
import { useTranslation } from "react-i18next";

import { getLanguageInfo } from "./i18n/languages";
import { resolveLanguagePreference } from "./i18n/resolveLanguage";

const queryClient = new QueryClient();

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

function AppContent() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>("loading");
  const { theme } = useTheme();
  const { available, version, downloading, progress, downloadAndInstall, dismissUpdate } = useUpdateCheck();
  const { isMobile } = usePlatform();
  const { settings, updateSetting, isLoaded } = useSettings();
  const { i18n } = useTranslation();

  // Handle active language and RTL direction changes
  useEffect(() => {
    if (!isLoaded) return;
    const activeLang = resolveLanguagePreference(settings.language);
    const info = getLanguageInfo(activeLang);
    i18n.changeLanguage(activeLang);
    document.documentElement.lang = activeLang;
    document.documentElement.dir = info.dir;
  }, [settings.language, isLoaded, i18n]);

  // Performance mode: auto-enable when user has prefers-reduced-motion
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mediaQuery.matches && !settings.performanceMode) {
      updateSetting('performanceMode', true);
    }
    const handler = (e: MediaQueryListEvent) => {
      if (e.matches && !settings.performanceMode) {
        updateSetting('performanceMode', true);
      }
    };
    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, []);

  // Apply performance-mode class to body (guarded by settings load to avoid flicker)
  useEffect(() => {
    if (!isLoaded) return;
    if (settings.performanceMode) {
      document.body.classList.add('performance-mode');
    } else {
      document.body.classList.remove('performance-mode');
    }
  }, [settings.performanceMode, isLoaded]);

  // On mount: check for a saved session and auto-restore it.
  // This is the SINGLE source of truth for the initial connection.
  // useTelegramConnection (inside Dashboard) no longer calls cmd_connect on mount.
  //
  // Yam Drive ships with its own embedded Telegram API ID/Hash (see
  // `telegram_credentials.rs` on the Rust side) — there's no per-user API
  // setup step anymore, so we no longer gate this on a saved `api_id` in
  // the local store. We always attempt to initialize the client; if there's
  // no prior login session on disk, `cmd_check_connection` simply comes
  // back false and the user sees the sign-in screen.
  useEffect(() => {
    const checkSession = async () => {
      try {
        // Initialize the client (uses the embedded API credentials).
        await invoke("cmd_connect");

        // Verify the session is still valid with Telegram servers
        const ok = await invoke<boolean>("cmd_check_connection");
        if (ok) {
          setAuthStatus("authenticated");
        } else {
          setAuthStatus("unauthenticated");
        }
      } catch (err) {
        console.warn("Session restore failed, showing login:", err);
        setAuthStatus("unauthenticated");
      }
    };

    checkSession();
  }, []);

  // Request OS notification permission once we're authenticated, so the
  // Rust-side message listener (spawned on connect) can actually show
  // desktop notifications for incoming Telegram messages.
  useEffect(() => {
    if (authStatus !== "authenticated") return;
    (async () => {
      try {
        let granted = await isPermissionGranted();
        if (!granted) {
          const permission = await requestPermission();
          granted = permission === "granted";
        }
      } catch (err) {
        console.warn("Notification permission request failed:", err);
      }
    })();
  }, [authStatus]);

  // Keep the Rust-side notification listener in sync with the persisted
  // "notificationsEnabled" setting (Settings > Language & Region).
  useEffect(() => {
    if (!isLoaded) return;
    invoke("cmd_set_notifications_enabled", { enabled: settings.notificationsEnabled }).catch(err => {
      console.warn("Failed to sync notification setting:", err);
    });
  }, [settings.notificationsEnabled, isLoaded]);

  // Styled splash screen while verifying the session
  if (authStatus === "loading") {
    return (
      <main className="h-screen w-screen flex items-center justify-center bg-telegram-bg">
        <div className="flex flex-col items-center gap-4">
          <img src="/logo.svg" className="w-16 h-16 drop-shadow-lg animate-pulse" alt="Yam Drive" />
          <p className="text-sm text-telegram-subtext tracking-wide">Restoring session...</p>
        </div>
      </main>
    );
  }

  return (
    <main className="absolute inset-0 text-telegram-text overflow-hidden selection:bg-telegram-primary/30">
      <UpdateBanner
        available={available}
        version={version}
        downloading={downloading}
        progress={progress}
        onUpdate={downloadAndInstall}
        onDismiss={dismissUpdate}
      />
      <Toaster theme={theme} position="bottom-center" />
      {authStatus === "authenticated" && (
        <Suspense fallback={
          <div className="h-screen w-screen flex flex-col items-center justify-center bg-telegram-bg">
            <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-telegram-primary"></div>
          </div>
        }>
          {isMobile ? (
            <ErrorBoundary>
              <MobileDashboard onLogout={() => setAuthStatus("unauthenticated")} />
            </ErrorBoundary>
          ) : (
            <ErrorBoundary>
              <DesktopDashboard onLogout={() => setAuthStatus("unauthenticated")} />
            </ErrorBoundary>
          )}
        </Suspense>
      )}
      {authStatus === "unauthenticated" && (
        <AuthWizard onLogin={() => setAuthStatus("authenticated")} />
      )}
    </main>
  );
}


function App() {
  const showDesignGallery = Boolean(
    DesignGallery && typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('design-gallery')
  );

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <ConfirmProvider>
            <SettingsProvider>
              <EncryptionProvider>
              {showDesignGallery && DesignGallery ? (
                <Suspense fallback={<div className="h-screen bg-app-canvas" />}>
                  <DesignGallery />
                </Suspense>
              ) : (
                <AppContent />
              )}
              </EncryptionProvider>
            </SettingsProvider>
          </ConfirmProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
