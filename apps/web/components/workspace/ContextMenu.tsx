'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';

export interface MenuItem {
  label?: string;
  icon?: React.ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  separator?: boolean;
  disabled?: boolean;
  shortcut?: string;
}

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/**
 * Lightweight desktop-style context menu. Mount the provider once per panel,
 * call `openMenu(e, items)` in onContextMenu handlers.
 */
export function useContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const openMenu = useCallback((e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    if (items.length === 0) return;
    setMenu({ x: e.clientX, y: e.clientY, items });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  useEffect(() => {
    if (!menu) return;

    const close = (ev: Event) => {
      if (ev instanceof MouseEvent && menuRef.current?.contains(ev.target as Node)) return;
      setMenu(null);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setMenu(null);
    };
    window.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

  const element =
    menu && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={menuRef}
            className="fixed z-[100] min-w-[180px] rounded-md border border-border bg-popover py-1 shadow-card-lift animate-fade-in"
            style={{
              left: Math.min(menu.x, window.innerWidth - 200),
              top: Math.min(menu.y, window.innerHeight - menu.items.length * 26 - 12),
            }}
            onContextMenu={(e) => e.preventDefault()}
          >
            {menu.items.map((item, i) =>
              item.separator ? (
                <div key={i} className="my-1 h-px bg-border/60" />
              ) : (
                <button
                  key={i}
                  disabled={item.disabled}
                  onClick={() => {
                    setMenu(null);
                    item.onSelect?.();
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1 text-left text-[11.5px] transition-colors',
                    item.disabled
                      ? 'cursor-default text-ink-muted/40'
                      : item.danger
                        ? 'text-red-400 hover:bg-red-500/10'
                        : 'text-ink-secondary hover:bg-primary-subtle hover:text-foreground',
                  )}
                >
                  {item.icon && <span className="flex h-3.5 w-3.5 items-center justify-center">{item.icon}</span>}
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.shortcut && (
                    <kbd className="text-[9px] text-ink-muted/70">{item.shortcut}</kbd>
                  )}
                </button>
              ),
            )}
          </div>,
          document.body,
        )
      : null;

  return { openMenu, closeMenu, contextMenu: element };
}
