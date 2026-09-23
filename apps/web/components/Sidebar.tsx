'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Files,
  Search,
  GitBranch,
  MessageSquare,
  Terminal as TerminalIcon,
  Plug,
  Server,
  LayoutDashboard,
  Code2,
  Share2,
  BookOpen,
  Cpu,
  Zap,
  BarChart3,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { RailRoot, RailBrand, RailButton, RailSections, RailDivider, RailLogout } from './rail';

/** Unused-import guard when lucide icons are dropped in the future. */
type ToolIcon = typeof Files;

const TOOLS: { key: string; tab: string; icon: ToolIcon; label: string }[] = [
  { key: 'explorer', tab: 'explorer', icon: Files, label: 'Files' },
  { key: 'search', tab: 'search', icon: Search, label: 'Search' },
  { key: 'scm', tab: 'scm', icon: GitBranch, label: 'Source Control (git changes)' },
  { key: 'agent', tab: 'agent', icon: MessageSquare, label: 'Chat history' },
  { key: 'terminal', tab: 'terminal', icon: TerminalIcon, label: 'Terminal' },
  { key: 'ssh', tab: 'ssh', icon: Server, label: 'SSH' },
];

/** Full page-nav list kept for the Chat page footer. */
export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/agent', label: 'Agent', icon: Code2 },
  { href: '/mcp', label: 'MCP', icon: Plug },
  { href: '/share', label: 'Share', icon: Share2 },
  { href: '/documents', label: 'Knowledge Base', icon: BookOpen },
  { href: '/models', label: 'Models', icon: Cpu },
  { href: '/playground', label: 'Playground', icon: Zap },
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/settings', label: 'Settings', icon: Settings },
];

/** Unified app rail — mirrors the agent workspace rail. Outside the
 *  workspace the tool icons redirect into /agent (and open that panel). */
export function Sidebar() {
  const router = useRouter();

  return (
    <RailRoot className="hidden lg:flex">
      {/* Brand */}
      <RailBrand />

      {/* Workspace tools — top group (redirects into the agent workspace) */}
      <div className="w-full flex-1 flex flex-col items-center gap-px py-1.5">
        {TOOLS.map(({ key, tab, icon: Icon, label }) => (
          <RailButton
            key={key}
            title={label}
            onClick={() => router.push(`/agent?panel=${tab}`)}
          >
            <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
          </RailButton>
        ))}
      </div>

      <RailDivider />

      {/* App sections — bottom group (redirects) */}
      <RailSections />

      {/* User / sign out */}
      <RailLogout />
    </RailRoot>
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