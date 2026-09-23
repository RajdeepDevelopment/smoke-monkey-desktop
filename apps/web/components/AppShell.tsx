'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { useAuth } from './AuthProvider';
import { Sidebar } from './Sidebar';
import { MobileNav } from './MobileNav';
import { MobileBottomNav } from './MobileNavigation';
import { OnboardingWizard } from './onboarding/OnboardingWizard';
import { BootLoader } from './BootLoader';
import { initExternalLinkHandling } from '../lib/external-links';

export const TITLES: Record<string, string> = {
  '/': 'Agent',
  '/dashboard': 'Dashboard',
  '/chat': 'Chat',
  '/agent': 'Agent',
  '/documents': 'Knowledge Base',
  '/models': 'Models',
  '/mcp': 'MCP Servers',
  '/playground': 'Playground',
  '/analytics': 'Analytics',
  '/settings': 'Settings',
  '/login': 'Sign in',
  '/register': 'Sign up',
};

const AUTH_PAGES = ['/login', '/register'];

/** Pages that render their own chrome (sidebar + header) and skip the shell's. */
const SELF_LAYOUT_PAGES = ['/', '/chat', '/agent'];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading, logout, needsOnboarding, dismissOnboarding } = useAuth();
  const rawPathname = usePathname();
  // Static exports serve "/agent.html" — normalize so self-layout pages match.
  const pathname = rawPathname?.replace(/\.html$/, '') ?? '/';
  const router = useRouter();
  const title = TITLES[pathname] ?? 'Smoke Monkey';
  const isAuthPage = AUTH_PAGES.includes(pathname);
  const isSelfLayout = SELF_LAYOUT_PAGES.includes(pathname);

  // Route guard: signed-out users are sent to /login, signed-in users away
  // from the auth pages.
  useEffect(() => {
    // Open external links in the OS browser instead of navigating the webview
    // away (which would trap the user with no way back).
    initExternalLinkHandling();
  }, []);

  useEffect(() => {
    if (loading) return;
    if (!user && !isAuthPage) {
      router.replace('/login');
    } else if (user && isAuthPage) {
      router.replace('/');
    }
  }, [loading, user, isAuthPage, router]);

  if (loading) {
    return <BootLoader />;
  }

  // Auth pages get a clean, centered layout — no app chrome.
  if (isAuthPage) {
    return (
      <div className="relative min-h-screen overflow-hidden bg-bg text-ink-primary">
        <div className="pointer-events-none absolute inset-0 bg-app-aurora" />
        <main className="relative z-10 flex min-h-screen w-full items-start justify-center px-4 py-10 sm:py-16">
          <div className="w-full max-w-sm">{children}</div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-bg text-ink-primary">
      {!isSelfLayout && <Sidebar />}
      <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        {!isSelfLayout && (
          <>
            {/* Desktop top bar */}
            <header className="hidden h-14 shrink-0 items-center justify-between gap-4 border-b border-surface-800/80 bg-bg-elevated/60 px-5 backdrop-blur lg:flex">
              <div className="flex min-w-0 items-center gap-3 self-center">
                <h1 className="truncate text-[15px] font-semibold text-slate-100">{title}</h1>
                {pathname !== '/' && pathname !== '/chat' && (
                  <span className="hidden items-center gap-1.5 text-xs text-slate-400 md:flex">
                    <span className="text-slate-600">›</span>
                    <span>Smoke Monkey</span>
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3">
                {user ? (
                  <>
                    <div className="flex items-center gap-2.5 rounded-full border border-white/10 bg-white/5 py-0.5 pl-0.5 pr-3.5 backdrop-blur-md">
                      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary ring-1 ring-inset ring-primary/20">
                        {(user.name || user.email || 'A').slice(0, 1).toUpperCase()}
                      </div>
                      <span className="hidden text-sm text-slate-100 md:block">{user.email}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        logout();
                        router.push('/login');
                      }}
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-800 hover:text-red-300"
                      aria-label="Sign out"
                      title="Sign out"
                    >
                      <LogOut className="h-4 w-4" />
                    </button>
                  </>
                ) : (
                  <a href="/login" className="btn-primary px-3 py-1.5">
                    Sign in
                  </a>
                )}
              </div>
            </header>
            {/* Mobile top bar */}
            <MobileNav title={title} />
          </>
        )}
        <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden">{children}</main>
        {!isSelfLayout && <MobileBottomNav />}
      </div>
      <OnboardingWizard open={!!user && needsOnboarding && !isAuthPage} onClose={dismissOnboarding} />
    </div>
  );
}
