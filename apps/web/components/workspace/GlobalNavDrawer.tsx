'use client';

import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard, Plug, Code2, BookOpen, Cpu, Zap,
  BarChart3, Settings, LogOut,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useAuth } from '../AuthProvider';

const NAV_ITEMS = [
  { href: '/', label: 'Agent', icon: Code2 },
  { href: '/mcp', label: 'MCP', icon: Plug },
  { href: '/documents', label: 'Knowledge Base', icon: BookOpen },
  { href: '/models', label: 'Models', icon: Cpu },
  { href: '/playground', label: 'Playground', icon: Zap },
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/settings', label: 'Settings', icon: Settings },
];

interface GlobalNavDrawerProps {
  open: boolean;
  onClose: () => void;
}

/** App-wide sections sidebar. Sits IN FLOW between the activity bar and the
 *  workspace — it animates its width and pushes content instead of covering
 *  it with an overlay. */
export function GlobalNavDrawer({ open, onClose }: GlobalNavDrawerProps) {
  const router = useRouter();
  const rawPathname = usePathname();
  const pathname = rawPathname?.replace(/\.html$/, '') ?? '/';
  const { user, logout } = useAuth();

  const go = (href: string) => {
    onClose();
    router.push(href);
  };

  return (
    <aside
      className={cn(
        'glass-panel glass-border-right flex shrink-0 flex-col overflow-hidden transition-[width] duration-200 ease-out',
        open ? 'w-56' : 'w-0',
      )}
      aria-hidden={!open}
    >
      {/* Fixed-width inner wrapper keeps content from squishing mid-animation */}
      <div className="flex h-full w-56 flex-col">
        <div className="flex h-10 shrink-0 items-center border-b border-border/60 px-3">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Smoke Monkey</span>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto scrollbar-thin p-2">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = href === '/agent' ? pathname.startsWith('/agent') : pathname === href;
            return (
              <button
                key={href}
                onClick={() => go(href)}
                aria-label={`Go to ${label}`}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[12px] transition-colors',
                  active
                    ? 'bg-primary-subtle text-foreground'
                    : 'text-ink-secondary hover:bg-white/[0.05] hover:text-foreground',
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                {label}
              </button>
            );
          })}
        </nav>

        <div className="shrink-0 border-t border-border/60 p-2">
          {user && (
            <p className="truncate px-2 pb-1 text-[10px] text-ink-muted">{user.email}</p>
          )}
          <button
            onClick={() => { onClose(); logout(); router.push('/login'); }}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[12px] text-ink-secondary transition-colors hover:bg-white/[0.05] hover:text-red-300"
          >
            <LogOut className="h-3.5 w-3.5 shrink-0" /> Sign out
          </button>
        </div>
      </div>
    </aside>
  );
}
