'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import {
  LayoutDashboard,
  MessageSquare,
  BookOpen,
  Cpu,
  Zap,
  BarChart3,
  Settings,
  Plus,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  LogOut,
  Globe,
  Code2,
  type LucideIcon,
} from 'lucide-react';
import { BrandIcon } from './BrandIcon';
import { useAuth } from './AuthProvider';
import { useToast } from './Toast';
import { cn } from '../lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './ui/tooltip';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const NAV: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/agent', label: 'Agent', icon: Code2 },
  { href: '/documents', label: 'Knowledge Base', icon: BookOpen },
  { href: '/models', label: 'Models', icon: Cpu },
  { href: '/playground', label: 'Playground', icon: Zap },
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/settings', label: 'Settings', icon: Settings },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Collapsible desktop sidebar (hidden below lg). */
export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const toast = useToast();

  const toggle = () => setCollapsed((c) => !c);
  const userName = user?.name || user?.email || 'Account';
  const initial = userName.slice(0, 1).toUpperCase();

  const handleLogout = () => {
    toast.info('Signed out', 'See you soon.');
    logout();
  };

  return (
    <TooltipProvider delayDuration={200}>
      <motion.aside
        animate={{ width: collapsed ? 76 : 264 }}
        transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
        className="relative z-20 hidden shrink-0 flex-col border-r border-surface-800/80 bg-bg-elevated/90 backdrop-blur lg:flex"
      >
        {/* Brand */}
        <div className={cn('flex h-16 shrink-0 items-center gap-2.5 border-b border-surface-800/60 px-4', collapsed && 'justify-center px-0')}>
          <Link href="/" className="flex min-w-0 items-center gap-2.5" aria-label="Smoke Monkey home">
            <BrandIcon size={36} className="rounded-lg" />
            <AnimatePresence initial={false}>
              {!collapsed && (
                <motion.span
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12 }}
                  className="truncate text-[15px] font-semibold tracking-tight text-white"
                >
                  Smoke Monkey
                </motion.span>
              )}
            </AnimatePresence>
          </Link>
        </div>

        {/* New chat */}
        <div className="px-3 pt-3">
          <Link
            href="/chat"
            className={cn(
              'flex items-center gap-2.5 rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground shadow-sm shadow-primary/20 transition-all hover:bg-primary-hover',
              collapsed ? 'justify-center px-0 py-2.5' : 'px-3',
            )}
            title={collapsed ? 'New chat' : undefined}
          >
            <Plus className="h-4 w-4 shrink-0" />
            <AnimatePresence initial={false}>
              {!collapsed && (
                <motion.span
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12 }}
                >
                  New chat
                </motion.span>
              )}
            </AnimatePresence>
          </Link>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-3 py-3">
          <p className={cn('mb-2 px-3 text-[10px] font-semibold uppercase tracking-widest text-ink-muted', collapsed && 'sr-only')}>
            Workspace
          </p>
          <ul className="space-y-1">
            {NAV.map((item) => {
              const active = isActive(pathname, item.href);
              const Icon = item.icon;
              const link = (
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                    collapsed && 'justify-center px-0',
                    active
                      ? 'bg-primary-subtle text-white'
                      : 'text-ink-secondary hover:bg-surface-800/70 hover:text-white',
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="nav-active-pill"
                      className="absolute inset-0 rounded-lg bg-primary-subtle"
                      transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                    />
                  )}
                  <Icon className="relative h-[18px] w-[18px] shrink-0" strokeWidth={active ? 2.2 : 2} />
                  <AnimatePresence initial={false}>
                    {!collapsed && (
                      <motion.span
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.12 }}
                        className="relative truncate"
                      >
                        {item.label}
                      </motion.span>
                    )}
                  </AnimatePresence>
                </Link>
              );

              if (!collapsed) return <li key={item.href}>{link}</li>;

              return (
                <li key={item.href}>
                  <Tooltip>
                    <TooltipTrigger asChild>{link}</TooltipTrigger>
                    <TooltipContent side="right">{item.label}</TooltipContent>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Footer: retrieval mode + user + collapse */}
        <div className="shrink-0 border-t border-surface-800/60 p-3">
          {!collapsed && (
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-surface-800 bg-surface-900/60 px-3 py-2.5">
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-ink-primary">Retrieval: Hybrid</p>
                <p className="text-[11px] text-ink-muted">Semantic + keyword</p>
              </div>
              <Globe className="h-3.5 w-3.5 text-ink-muted" />
            </div>
          )}

          <div className={cn('flex items-center gap-2', collapsed && 'flex-col gap-2')}>
            <div
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary',
                collapsed && 'h-9 w-9',
              )}
            >
              {initial}
            </div>
            {!collapsed && (
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-ink-primary">{userName}</p>
                <p className="truncate text-[11px] text-ink-muted">Pro workspace</p>
              </div>
            )}
            {!collapsed && (
              <button
                type="button"
                onClick={handleLogout}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-800 hover:text-red-300"
                aria-label="Sign out"
                title="Sign out"
              >
                <LogOut className="h-4 w-4" />
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={toggle}
            className={cn(
              'mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-surface-800 py-1.5 text-[11px] font-medium text-ink-muted transition-colors hover:bg-surface-800/70 hover:text-ink-primary',
              collapsed && 'mt-2 border-0 py-1',
            )}
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <>
                <PanelLeftClose className="h-4 w-4" />
                Collapse
              </>
            )}
          </button>
        </div>
      </motion.aside>
    </TooltipProvider>
  );
}

/** Compact search trigger shown in the top bar (desktop). */
export function TopBarSearch() {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative hidden md:block">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
      <input
        type="text"
        placeholder="Search…"
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="h-9 w-44 rounded-lg border border-surface-800 bg-surface-900/70 pl-8 pr-3 text-sm text-ink-primary placeholder:text-ink-muted transition-all focus:w-56 focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-ring/25 lg:w-52"
      />
      {open && (
        <div className="absolute left-0 right-0 top-full z-30 mt-2 rounded-xl border border-surface-700 bg-surface-900 p-1 text-xs text-ink-muted shadow-card-lift">
          <p className="px-3 py-2">Global search is on the roadmap.</p>
        </div>
      )}
    </div>
  );
}
