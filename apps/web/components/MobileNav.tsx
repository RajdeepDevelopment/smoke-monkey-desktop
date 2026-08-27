'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Menu } from 'lucide-react';
import { BrandIcon } from './BrandIcon';
import { MobileDrawer } from './MobileNavigation';

interface MobileNavProps {
  title?: string;
  /** Optional right-side slot rendered in the mobile top bar (e.g. actions). */
  right?: ReactNode;
}

/**
 * Mobile chrome: a slim 56px top bar with hamburger + brand. The hamburger
 * opens the full application drawer (navigation + recent chats + account).
 * Used by the app shell on non-chat pages.
 */
export function MobileNav({ title, right }: MobileNavProps) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-surface-800/80 bg-bg-elevated/90 px-2.5 backdrop-blur lg:hidden">
      <MobileDrawer
        trigger={
          <button
            type="button"
            className="flex h-10 w-10 min-w-10 min-h-10 items-center justify-center rounded-lg text-ink-secondary transition-colors hover:bg-surface-800 hover:text-white"
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </button>
        }
      />

      <Link href="/" className="flex min-w-0 items-center gap-2" aria-label="Smoke Monkey home">
        <BrandIcon size={32} className="rounded-md" />
        <span className="truncate text-sm font-semibold text-white">{title ?? 'Smoke Monkey'}</span>
      </Link>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">{right}</div>
    </header>
  );
}
