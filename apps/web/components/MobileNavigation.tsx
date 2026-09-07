'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  BookOpen,
  Cpu,
  Plug,
  Code2,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Settings,
  User,
  BarChart3,
  Zap,
  Key,
  Globe,
  BrainCircuit,
  Share2,
  ChevronRight,
} from 'lucide-react';
import type { ConversationDto } from '@rag/contracts';
import { api } from '../lib/api';
import { useAuth } from './AuthProvider';
import { useToast } from './Toast';
import { BrandIcon } from './BrandIcon';
import { cn } from '../lib/utils';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from './ui/sheet';
import { Separator } from './ui/separator';

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/* ────────────────────────────────────────────────────────────────────────
 * Shared navigation rows
 * ──────────────────────────────────────────────────────────────────────── */

interface RowProps {
  href?: string;
  icon: ReactNode;
  label: string;
  active?: boolean;
  onNavigate?: () => void;
  chevron?: boolean;
}

function NavRow({ href, icon, label, active, onNavigate, chevron }: RowProps) {
  const inner = (
    <>
      <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center', active ? 'text-primary-hover' : 'text-ink-muted')}>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
      {chevron && <ChevronRight className="h-4 w-4 shrink-0 text-ink-muted" />}
    </>
  );
  const cls = cn(
    'flex w-full min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors',
    active ? 'bg-primary-subtle font-medium text-white' : 'text-ink-secondary hover:bg-surface-800 hover:text-white',
  );
  if (href) {
    return (
      <Link href={href} onClick={onNavigate} className={cls}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onNavigate} className={cls}>
      {inner}
    </button>
  );
}

const PRIMARY_SECTIONS = [
  { href: '/', label: 'Agent', icon: <Code2 className="h-[18px] w-[18px]" /> },
  { href: '/mcp', label: 'MCP', icon: <Plug className="h-[18px] w-[18px]" /> },
  { href: '/documents', label: 'Knowledge Base', icon: <BookOpen className="h-[18px] w-[18px]" /> },
];

const MORE_SECTIONS = [
  { href: '/models', label: 'Models', icon: <Cpu className="h-[18px] w-[18px]" /> },
  { href: '/playground', label: 'Playground', icon: <Zap className="h-[18px] w-[18px]" /> },
  { href: '/share', label: 'Share', icon: <Share2 className="h-[18px] w-[18px]" /> },
  { href: '/analytics', label: 'Analytics', icon: <BarChart3 className="h-[18px] w-[18px]" /> },
  { href: '/settings', label: 'Settings', icon: <Settings className="h-[18px] w-[18px]" /> },
];

/* ────────────────────────────────────────────────────────────────────────
 * MobileDrawer — hamburger → full application navigation. Recent chats are
 * a subsection below the nav, never a replacement for it.
 * ──────────────────────────────────────────────────────────────────────── */

interface MobileDrawerProps {
  /** Hamburger button rendered as the sheet trigger. */
  trigger: ReactNode;
  /** Optional recent-chat list (chat screen passes its live list). */
  recentChats?: ConversationDto[];
  /** Active conversation id (chat screen). */
  activeChatId?: string | null;
  onOpenChat?: (id: string) => void;
  onNewChat?: () => void;
}

export function MobileDrawer({
  trigger,
  recentChats,
  activeChatId,
  onOpenChat,
  onNewChat,
}: MobileDrawerProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [convos, setConvos] = useState<ConversationDto[]>([]);

  const chats = recentChats ?? convos;

  // Refresh the recent-chats subsection every time the drawer opens so it is
  // never stale (AppShell pages don't pass a live list).
  useEffect(() => {
    if (!open || !user || recentChats) return;
    api
      .listConversations()
      .then(setConvos)
      .catch(() => setConvos([]));
  }, [open, user, recentChats]);

  const close = () => setOpen(false);

  const handleNewChat = () => {
    close();
    if (onNewChat) {
      onNewChat();
    } else {
      router.push('/chat');
    }
  };

  const handleOpenChat = (id: string) => {
    close();
    if (onOpenChat) {
      onOpenChat(id);
    } else {
      router.push(`/chat?c=${id}`);
    }
  };

  const handleLogout = () => {
    close();
    toast.info('Signed out', 'See you soon.');
    logout();
    router.push('/login');
  };

  const userName = user?.name || user?.email || 'Account';
  const initial = userName.slice(0, 1).toUpperCase();

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent side="left" className="flex flex-col p-0">
        <SheetHeader className="border-b border-surface-800/60 py-3 pr-12 pl-4">
          <SheetTitle asChild>
            <div className="flex items-center gap-2.5">
              <BrandIcon size={36} className="rounded-lg" />
              <span className="text-[15px] font-semibold tracking-tight text-white">Smoke Monkey</span>
            </div>
          </SheetTitle>
        </SheetHeader>

        <div className="px-3 pt-3">
          <button
            type="button"
            onClick={handleNewChat}
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2.5 text-sm font-medium text-primary-foreground shadow-sm shadow-primary/20"
          >
            <Plus className="h-4 w-4" />
            New chat
          </button>
        </div>

        <nav className="shrink-0 overflow-y-auto px-3 py-3 scrollbar-thin">
          <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-widest text-ink-muted">Workspace</p>
          <div className="space-y-0.5">
            {[...PRIMARY_SECTIONS, ...MORE_SECTIONS].map((item) => (
              <NavRow
                key={item.href}
                href={item.href}
                icon={item.icon}
                label={item.label}
                active={isActive(pathname, item.href)}
                onNavigate={close}
              />
            ))}
          </div>
        </nav>

        <div className="flex min-h-0 flex-1 flex-col border-t border-surface-800/60">
          <div className="px-4 pb-1 pt-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-ink-muted">Recent chats</p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 scrollbar-thin">
            {chats.length === 0 ? (
              <p className="px-2 py-2 text-xs text-ink-muted">No conversations yet.</p>
            ) : (
              <div className="space-y-0.5">
                {chats.map((c) => {
                  const active = activeChatId === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => handleOpenChat(c.id)}
                      className={cn(
                        'flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-[13px] transition-colors',
                        active
                          ? 'bg-primary-subtle font-medium text-white'
                          : 'text-ink-secondary hover:bg-surface-800 hover:text-white',
                      )}
                      title={c.title}
                    >
                      <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 border-t border-surface-800/60 p-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
              {initial}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-ink-primary">{userName}</p>
              <p className="truncate text-[11px] text-ink-muted">{user?.email}</p>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-800 hover:text-red-300"
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * MoreSheet — the "⋯" sheet that exposes every remaining destination.
 * ──────────────────────────────────────────────────────────────────────── */

function MoreSheetContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();
  const toast = useToast();

  const handleLogout = () => {
    toast.info('Signed out', 'See you soon.');
    logout();
    router.push('/login');
  };

  return (
    <SheetContent side="bottom" className="max-h-[min(80dvh,620px)] p-0">
      <SheetHeader className="border-b border-surface-800/60 py-3 pr-12 pl-4">
        <SheetTitle className="text-sm">More</SheetTitle>
      </SheetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 pb-safe">
        <div className="space-y-0.5">
          {MORE_SECTIONS.map((item) => (
            <NavRow
              key={item.href}
              href={item.href}
              icon={item.icon}
              label={item.label}
              active={isActive(pathname, item.href)}
              chevron
              onNavigate={onNavigate}
            />
          ))}
        </div>

        <Separator className="my-2 bg-surface-800" />

        <div className="space-y-0.5">
          <NavRow href="/settings" icon={<Key className="h-[18px] w-[18px]" />} label="API Keys" chevron onNavigate={onNavigate} />
          <NavRow href="/settings" icon={<Globe className="h-[18px] w-[18px]" />} label="Web Search" chevron onNavigate={onNavigate} />
          <NavRow href="/settings" icon={<BrainCircuit className="h-[18px] w-[18px]" />} label="Super Memory" chevron onNavigate={onNavigate} />
        </div>

        <Separator className="my-2 bg-surface-800" />

        <div className="space-y-0.5">
          <NavRow href="/settings" icon={<User className="h-[18px] w-[18px]" />} label="Account" chevron onNavigate={onNavigate} />
          <NavRow icon={<LogOut className="h-[18px] w-[18px]" />} label="Sign out" onNavigate={handleLogout} />
        </div>
      </div>
    </SheetContent>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * MobileBottomNav — persistent Home | Chat | Knowledge | More bar.
 * Rendered by the app shell (and the chat workspace) below lg.
 * ──────────────────────────────────────────────────────────────────────── */

export function MobileBottomNav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  const items = [
    { href: '/', label: 'Agent', icon: <Code2 className="h-5 w-5" /> },
    { href: '/documents', label: 'Knowledge', icon: <BookOpen className="h-5 w-5" /> },
    { href: '/mcp', label: 'MCP', icon: <Plug className="h-5 w-5" /> },
  ];

  return (
    <nav
      className="z-30 shrink-0 border-t border-surface-800 bg-bg-elevated/95 pb-safe backdrop-blur lg:hidden"
      aria-label="Primary navigation"
    >
      <div className="flex h-14 items-center justify-around px-1 sm:h-16">
        {items.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'relative flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-all duration-150 active:scale-95',
                active ? 'text-white font-semibold' : 'text-ink-muted hover:text-ink-primary',
              )}
            >
              <div
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-xl transition-all',
                  active ? 'bg-primary/20 text-primary-hover shadow-sm shadow-primary/20' : 'text-ink-muted',
                )}
              >
                {item.icon}
              </div>
              <span className="leading-none">{item.label}</span>
            </Link>
          );
        })}

        <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
          <SheetTrigger asChild>
            <button
              type="button"
              className="relative flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium text-ink-muted transition-all duration-150 hover:text-ink-primary active:scale-95"
              aria-label="More options"
            >
              <div className="flex h-7 w-7 items-center justify-center rounded-xl text-ink-muted">
                <MoreHorizontal className="h-5 w-5" />
              </div>
              <span className="leading-none">More</span>
            </button>
          </SheetTrigger>
          <MoreSheetContent onNavigate={() => setMoreOpen(false)} />
        </Sheet>
      </div>
    </nav>
  );
}
