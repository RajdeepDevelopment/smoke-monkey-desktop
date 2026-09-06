'use client';

import { memo, useCallback, useRef, useState, useEffect, type ReactNode } from 'react';
import { useWorkspace } from '../../hooks/useWorkspace';
import { cn } from '../../lib/utils';

interface SidePanelProps {
  children: ReactNode;
  width?: number;
  onWidthChange?: (width: number) => void;
  /** When true the panel slides in/out (pushing content) instead of mounting/unmounting. */
  pushAnimation?: boolean;
}

export const SidePanel = memo(function SidePanel({
  children,
  width: controlledWidth,
  onWidthChange,
  pushAnimation = false,
}: SidePanelProps) {
  const { state, dispatch } = useWorkspace();
  const panelRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  const width = controlledWidth ?? state.explorerWidth;

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    dragStartX.current = e.clientX;
    dragStartWidth.current = width;
  }, [width]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging) return;
    const delta = e.clientX - dragStartX.current;
    const newWidth = Math.max(180, Math.min(420, dragStartWidth.current + delta));
    if (onWidthChange) {
      onWidthChange(newWidth);
    } else {
      dispatch({ type: 'SET_EXPLORER_WIDTH', width: newWidth });
    }
  }, [isDragging, onWidthChange, dispatch]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp]);

  const isOpen = state.sidePanelOpen;
  if (!isOpen && !pushAnimation) return null;

  return (
    <>
      <div
        ref={panelRef}
        className={cn(
          'shrink-0 flex flex-col glass-panel overflow-hidden',
          isOpen && 'glass-border',
          pushAnimation && 'transition-[width] ease-out border-0',
        )}
        style={{ width: isOpen ? width : 0, transitionDuration: pushAnimation ? '200ms' : undefined }}
      >
        {children}
      </div>
      {/* Resize handle */}
      {isOpen && (
        <div
          onMouseDown={handleMouseDown}
          className={cn(
            'w-1 shrink-0 cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors relative z-10',
            isDragging && 'bg-primary/40',
          )}
        >
          <div className="absolute inset-y-0 left-0 right-0 -mx-1" />
        </div>
      )}
    </>
  );
});
