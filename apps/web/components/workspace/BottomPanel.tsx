'use client';

import { memo, useCallback, useRef, useState, useEffect } from 'react';
import { Pin, PinOff, ChevronUp, Terminal as TerminalIcon } from 'lucide-react';
import { useWorkspace } from '../../hooks/useWorkspace';
import { cn } from '../../lib/utils';

interface BottomPanelProps {
  children: React.ReactNode;
  header?: React.ReactNode;
}

export const BottomPanel = memo(function BottomPanel({ children, header }: BottomPanelProps) {
  const { state, expandBottomPanel, collapseBottomPanel, pinBottomPanel, unpinBottomPanel, dispatch } = useWorkspace();
  const panelRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);
  const [isHovered, setIsHovered] = useState(false);

  const { bottomPanelState, terminalHeight } = state;
  const isExpanded = bottomPanelState === 'expanded' || bottomPanelState === 'pinned';
  const isPinned = bottomPanelState === 'pinned';

  // Smart auto-collapse: when user interacts with editor/agent, collapse if not pinned
  const handleWorkspaceInteraction = useCallback(() => {
    if (isExpanded && !isPinned) {
      collapseBottomPanel();
    }
  }, [isExpanded, isPinned, collapseBottomPanel]);

  // Hover to expand (only when collapsed)
  const handleMouseEnter = useCallback(() => {
    if (bottomPanelState === 'collapsed') {
      setIsHovered(true);
      expandBottomPanel();
    }
  }, [bottomPanelState, expandBottomPanel]);

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
    if (bottomPanelState === 'expanded' && !isPinned) {
      collapseBottomPanel();
    }
  }, [bottomPanelState, isPinned, collapseBottomPanel]);

  // Resize handle
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    dragStartY.current = e.clientY;
    dragStartHeight.current = terminalHeight;
  }, [terminalHeight]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging) return;
    const delta = dragStartY.current - e.clientY;
    const newHeight = Math.max(100, Math.min(500, dragStartHeight.current + delta));
    dispatch({ type: 'SET_TERMINAL_HEIGHT', height: newHeight });
  }, [isDragging, dispatch]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp]);

  return (
    <div
      ref={panelRef}
      className="shrink-0 flex flex-col glass-panel overflow-hidden transition-all duration-200"
      style={{ height: isExpanded ? terminalHeight : 32 }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Resize handle */}
      {isExpanded && (
        <div
          onMouseDown={handleMouseDown}
          className={cn(
            'h-1 shrink-0 cursor-row-resize hover:bg-primary/30 active:bg-primary/50 transition-colors',
            isDragging && 'bg-primary/40',
          )}
        />
      )}

      {/* Status bar / header */}
      <div className="flex items-center justify-between px-3 py-1 shrink-0 h-8">
        <div className="flex items-center gap-2">
          <TerminalIcon className="h-3.5 w-3.5 text-ink-muted" />
          <span className="text-[11px] font-medium text-foreground/80">Terminal</span>
          {header}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => isPinned ? unpinBottomPanel() : pinBottomPanel()}
            className="p-1 rounded text-ink-muted hover:text-foreground glass-hover transition-colors"
            title={isPinned ? 'Unpin' : 'Pin'}
          >
            {isPinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
          </button>
          <button
            onClick={() => isExpanded ? collapseBottomPanel() : expandBottomPanel()}
            className="p-1 rounded text-ink-muted hover:text-foreground glass-hover transition-colors"
            title={isExpanded ? 'Collapse' : 'Expand'}
          >
            <ChevronUp className={cn('h-3 w-3 transition-transform', !isExpanded && 'rotate-180')} />
          </button>
        </div>
      </div>

      {/* Content - always render children so terminal mounts, hide via overflow when collapsed */}
      <div className={cn(
        'flex-1 min-h-0 overflow-hidden transition-all',
        !isExpanded && 'h-0',
      )}>
        {children}
      </div>
    </div>
  );
});
