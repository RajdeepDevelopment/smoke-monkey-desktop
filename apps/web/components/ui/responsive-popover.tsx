'use client';

import { useState, type ReactNode } from 'react';
import { useIsMobile } from '../../lib/hooks';
import { cn } from '../../lib/utils';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from './popover';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from './sheet';

interface ResponsivePopoverProps {
  trigger: ReactNode;
  children: ReactNode;
  /** Desktop popover alignment relative to the trigger. */
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  /** Extra classes applied to the desktop popover content. */
  className?: string;
  /** Title shown in the mobile bottom-sheet header. */
  sheetTitle?: string;
  /** Max height for the mobile sheet. */
  sheetMaxHeight?: string;
}

/**
 * One trigger, two surfaces: a Radix Popover on desktop and a bottom Sheet on
 * mobile. Prevents the classic "desktop dropdown overflowing a 390px phone"
 * bug — popovers must never leave the viewport.
 */
export function ResponsivePopover({
  trigger,
  children,
  align = 'start',
  sideOffset = 6,
  className,
  sheetTitle,
  sheetMaxHeight = 'min(80dvh, 640px)',
}: ResponsivePopoverProps) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <SheetContent side="bottom" className="p-0" style={{ maxHeight: sheetMaxHeight }}>
          {sheetTitle && (
            <SheetHeader className="border-b border-surface-800 px-4 py-3">
              <SheetTitle className="text-sm">{sheetTitle}</SheetTitle>
            </SheetHeader>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto p-3 pb-safe">{children}</div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align={align}
        sideOffset={sideOffset}
        collisionPadding={16}
        avoidCollisions
        className={cn('w-80 max-w-[calc(100vw-24px)] p-3', className)}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
