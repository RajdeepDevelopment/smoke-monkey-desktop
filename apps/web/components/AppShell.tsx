'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { useAuth } from './AuthProvider';
import { Sidebar, TopBarSearch } from './Sidebar';
import { MobileNav } from './MobileNav';
import { MobileBottomNav } from './MobileNavigation';

export const TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/chat': 'Chat',
  '/documents': 'Knowledge Base',
  '/models': 'Models',
  '/playground': 'Playground',
  '/analytics': 'Analytics',
  '/settings': 'Settings',
  '/login': 'Sign in',
  '/register': 'Sign up',
};

const AUTH_PAGES = ['/login', '/register'];

/** Pages that render their own chrome (sidebar + header) and skip the shell's. */
const SELF_LAYOUT_PAGES = ['/chat', '/agent'];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth();
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
    if (loading) return;
    if (!user && !isAuthPage) {
      router.replace('/login');
    } else if (user && isAuthPage) {
      router.replace('/');
    }
  }, [loading, user, isAuthPage, router]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
      </div>
    );
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
            <header className="hidden h-16 shrink-0 items-center justify-between gap-4 border-b border-surface-800/80 bg-bg-elevated/60 px-6 backdrop-blur lg:flex">
              <div className="flex min-w-0 items-center gap-3">
                <h1 className="truncate text-[15px] font-semibold text-white">{title}</h1>
                {pathname !== '/' && pathname !== '/chat' && (
                  <span className="hidden items-center gap-1.5 text-xs text-ink-muted md:flex">
                    Smoke Monkey
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3">
                <TopBarSearch />
                {user ? (
                  <>
                    <div className="flex items-center gap-2.5">
                      <span className="hidden text-sm text-ink-secondary md:block">{user.email}</span>
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                        {(user.name || user.email || 'A').slice(0, 1).toUpperCase()}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        logout();
                        router.push('/login');
                      }}
                      className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-800 hover:text-red-300"
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
    </div>
  );
}
