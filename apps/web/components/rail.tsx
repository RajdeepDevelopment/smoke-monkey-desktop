'use client';

import { memo, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePathname, useRouter } from 'next/navigation';
import {
  Plug,
  BookOpen,
  Cpu,
  BarChart3,
  Settings,
  LogOut,
} from 'lucide-react';
import { useAuth } from './AuthProvider';
import { BrandIcon } from './BrandIcon';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from './ui/tooltip';
import { cn } from '../lib/utils';

// ── Shared section nav (redirects) ──────────────────────────────────────

export const RAIL_SECTIONS: { href: string; label: string; icon: typeof Plug }[] = [
  { href: '/mcp', label: 'MCP', icon: Plug },
  { href: '/documents', label: 'Knowledge Base', icon: BookOpen },
  { href: '/models', label: 'Models', icon: Cpu },
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/settings', label: 'Settings', icon: Settings },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

// ── Rail root — tooltip scope + premium glass container ────────────────

export const RailRoot = memo(function RailRoot({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <TooltipProvider delayDuration={180} skipDelayDuration={150}>
      <div
        className={cn(
          'relative flex h-full w-12 shrink-0 flex-col items-center border-r border-white/[0.06] bg-gradient-to-b from-surface-900/90 via-surface-900/70 to-surface-950/90 backdrop-blur-xl shadow-[inset_-1px_0_0_rgba(255,255,255,0.02)]',
          className,
        )}
      >
        <span className="pointer-events-none absolute inset-y-0 left-0 w-px bg-gradient-to-b from-transparent via-primary/25 to-transparent" />
        {children}
      </div>
    </TooltipProvider>
  );
});

// ── Rail button ─────────────────────────────────────────────────────────

interface RailButtonProps {
  active?: boolean;
  badge?: string | number;
  running?: boolean;
  dot?: boolean;
  dotColor?: 'emerald' | 'muted';
  onClick?: () => void;
  title: string;
  children: ReactNode;
  className?: string;
}

export const RailButton = memo(function RailButton({
  active,
  badge,
  running,
  dot,
  dotColor = 'emerald',
  onClick,
  title,
  children,
  className,
}: RailButtonProps) {
  return (
    <Tooltip delayDuration={60}>
      <TooltipTrigger asChild>
        <button
          aria-label={title}
          onClick={onClick}
          className={cn(
            'group relative flex h-11 w-12 items-center justify-center transition-colors duration-150',
            active ? 'text-white' : 'text-ink-muted/80 hover:text-white',
            className,
          )}
        >
          {/* Active left gradient bar */}
          <span
            className={cn(
              'absolute left-[3px] top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full transition-all duration-200',
              active
                ? 'bg-gradient-to-b from-violet-400 to-indigo-500 opacity-100 shadow-[0_0_10px_rgba(129,140,248,0.6)]'
                : 'opacity-0',
            )}
          />
          {/* Icon tile */}
          <span
            className={cn(
              'relative flex h-9 w-9 items-center justify-center rounded-xl transition-all duration-200',
              active
                ? 'bg-gradient-to-br from-primary/30 via-primary/15 to-transparent ring-1 ring-primary/30 shadow-[0_0_16px_rgba(99,102,241,0.25)]'
                : 'group-hover:bg-white/[0.07] group-hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]',
            )}
          >
            {active && (
              <span className="pointer-events-none absolute inset-0 rounded-xl bg-primary/10 blur-sm" />
            )}
            <span className="relative">{children}</span>
            {running && (
              <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_6px_rgba(251,191,36,0.8)] animate-pulse" />
            )}
          </span>
          {badge != null && badge !== '' && (
            <span className="absolute bottom-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-gradient-to-r from-violet-500 to-indigo-500 px-0.5 text-[8px] font-bold text-white shadow-[0_0_8px_rgba(99,102,241,0.5)] ring-1 ring-white/20">
              {Number(badge) > 99 ? '99+' : String(badge)}
            </span>
          )}
          {dot && (
            <span
              className={cn(
                'absolute bottom-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full',
                dotColor === 'emerald'
                  ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]'
                  : 'bg-surface-600/70',
              )}
            />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={10}>
        {title}
      </TooltipContent>
    </Tooltip>
  );
});

// ── Divider ─────────────────────────────────────────────────────────────

export const RailDivider = memo(function RailDivider({ className }: { className?: string }) {
  return <span className={cn('my-1.5 block h-px w-8 bg-gradient-to-r from-transparent via-white/10 to-transparent', className)} />;
});

// ── Brand mark ──────────────────────────────────────────────────────────

export const RailBrand = memo(function RailBrand() {
  const router = useRouter();
  const pathname = usePathname();

  const goHome = () => {
    // The app home is the agent workspace. If we're already there, stay put so
    // the repeated clicks never cause the / → /agent redirect flash.
    const target = '/agent';
    if (pathname === target || pathname === '/' || pathname.startsWith(`${target}/`)) return;
    router.push(target);
  };

  return (
    <Tooltip delayDuration={60}>
      <TooltipTrigger asChild>
        <button
          onClick={goHome}
          className="group relative flex h-12 w-12 items-center justify-center"
          aria-label="Smoke Monkey home"
        >
          <span className="relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-[11px] bg-gradient-to-br from-white/15 via-white/5 to-transparent p-[2px] ring-1 ring-inset ring-white/15 shadow-[0_2px_8px_rgba(0,0,0,0.3)] transition-all duration-200 group-hover:scale-[1.06] group-hover:shadow-[0_0_16px_rgba(255,255,255,0.1)] group-hover:ring-white/25">
            <BrandIcon size={26} />
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={10}>
        Smoke Monkey
      </TooltipContent>
    </Tooltip>
  );
});

// ── Section buttons (router + active state) ────────────────────────────

interface RailSectionsProps {
  /** Override navigation; defaults to router.push(href) */
  onNavigate?: (href: string) => void;
  className?: string;
}

export const RailSections = memo(function RailSections({ onNavigate, className }: RailSectionsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const navigate = onNavigate ?? ((href: string) => router.push(href));

  return (
    <div className={cn('w-full flex flex-col items-center py-1.5', className)}>
      {RAIL_SECTIONS.map(({ href, label, icon: Icon }) => {
        const active = isActive(pathname, href);
        return (
          <RailButton
            key={href}
            active={active}
            title={label}
            onClick={() => navigate(href)}
          >
            <Icon className="h-[18px] w-[18px]" strokeWidth={active ? 2.2 : 1.8} />
          </RailButton>
        );
      })}
    </div>
  );
});

// ── User menu ───────────────────────────────────────────────────────────

export const RailLogout = memo(function RailLogout() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const initial = (user?.name || user?.email || 'A').slice(0, 1).toUpperCase();

  useEffect(() => setMounted(true), []);

  const handleLogout = () => {
    setOpen(false);
    logout();
    router.push('/login');
  };

  return (
    <div className="relative w-full flex flex-col items-center pb-2.5 pt-1.5">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Account options"
        aria-expanded={open}
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-semibold transition-all duration-200',
          open
            ? 'bg-gradient-to-br from-primary/40 to-indigo-500/30 text-primary ring-1 ring-primary/40 shadow-[0_0_12px_rgba(99,102,241,0.3)]'
            : 'bg-gradient-to-br from-white/10 to-white/[0.03] text-slate-300 ring-1 ring-inset ring-white/10 hover:ring-white/25 hover:text-white',
        )}
      >
        {initial}
      </button>

      {open &&
        mounted &&
        createPortal(
          <>
            <button
              aria-label="Close account menu"
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-[90] cursor-default bg-transparent"
            />
            {/* Portaled to <body> so the menu escapes the rail backdrop-blur
                stacking context and always floats above the Explorer/file
                tree and any other open side bar. */}
            <div className="fixed bottom-3 left-[52px] z-[100] w-56 overflow-hidden rounded-lg border border-white/10 bg-surface-900/95 shadow-card-lift backdrop-blur-xl">
              <div className="border-b border-white/[0.06] px-3 py-2.5">
                <p className="truncate text-xs font-medium text-ink-primary">{user?.name || 'Account'}</p>
                <p className="truncate text-[10px] text-ink-muted">{user?.email || ''}</p>
              </div>
              <button
                onClick={() => { setOpen(false); router.push('/settings'); }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] text-ink-secondary transition-colors hover:bg-white/[0.05] hover:text-ink-primary"
              >
                <Settings className="h-3.5 w-3.5" /> Settings
              </button>
              <button
                onClick={handleLogout}
                className="flex w-full items-center gap-2 rounded-b-lg border-t border-white/[0.06] px-3 py-2 text-left text-[11px] text-red-300 transition-colors hover:bg-red-400/10"
              >
                <LogOut className="h-3.5 w-3.5" /> Sign out
              </button>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
});