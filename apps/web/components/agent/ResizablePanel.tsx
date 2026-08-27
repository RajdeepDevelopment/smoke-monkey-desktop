'use client';

import { useCallback, useRef, useState, useEffect, type ReactNode } from 'react';
import { cn } from '../../lib/utils';

interface ResizablePanelProps {
  children: [ReactNode, ReactNode];
  defaultLeftWidth?: number;
  minLeftWidth?: number;
  maxLeftWidth?: number;
  minRightWidth?: number;
  persistKey?: string;
  className?: string;
}

export function ResizablePanel({
  children,
  defaultLeftWidth = 45,
  minLeftWidth = 280,
  maxLeftWidth = 70,
  minRightWidth = 280,
  persistKey,
  className,
}: ResizablePanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [leftWidth, setLeftWidth] = useState(defaultLeftWidth);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  // Load persisted width
  useEffect(() => {
    if (persistKey) {
      const saved = localStorage.getItem(`sm-panel-${persistKey}`);
      if (saved) {
        const num = parseFloat(saved);
        if (!isNaN(num) && num > 0 && num <= 100) setLeftWidth(num);
      }
    }
  }, [persistKey]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    dragStartX.current = e.clientX;
    dragStartWidth.current = leftWidth;
  }, [leftWidth]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging || !containerRef.current) return;
    const containerWidth = containerRef.current.offsetWidth;
    const deltaX = e.clientX - dragStartX.current;
    const deltaPercent = (deltaX / containerWidth) * 100;
    const newWidth = Math.max(minLeftWidth / containerWidth * 100, Math.min(maxLeftWidth, dragStartWidth.current + deltaPercent));
    setLeftWidth(newWidth);
    if (persistKey) {
      localStorage.setItem(`sm-panel-${persistKey}`, String(newWidth));
    }
  }, [isDragging, minLeftWidth, maxLeftWidth, persistKey]);

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

  return (
    <div ref={containerRef} className={cn('flex h-full w-full overflow-hidden', className)}>
      <div style={{ width: `${leftWidth}%`, minWidth: minLeftWidth }} className="h-full overflow-hidden shrink-0">
        {children[0]}
      </div>
      <div
        onMouseDown={handleMouseDown}
        className={cn(
          'w-1 shrink-0 cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors relative z-10',
          isDragging && 'bg-primary/40',
        )}
      >
        <div className="absolute inset-y-0 left-0 right-0 -mx-1" />
      </div>
      <div className="flex-1 min-w-0 h-full overflow-hidden">
        {children[1]}
      </div>
    </div>
  );
}

interface ResizableVerticalProps {
  children: [ReactNode, ReactNode];
  defaultTopHeight?: number;
  minTopHeight?: number;
  maxTopHeight?: number;
  persistKey?: string;
  className?: string;
}

export function ResizableVertical({
  children,
  defaultTopHeight = 50,
  minTopHeight = 100,
  maxTopHeight = 80,
  persistKey,
  className,
}: ResizableVerticalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [topHeight, setTopHeight] = useState(defaultTopHeight);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);

  useEffect(() => {
    if (persistKey) {
      const saved = localStorage.getItem(`sm-vpanel-${persistKey}`);
      if (saved) {
        const num = parseFloat(saved);
        if (!isNaN(num) && num > 0 && num <= 100) setTopHeight(num);
      }
    }
  }, [persistKey]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    dragStartY.current = e.clientY;
    dragStartHeight.current = topHeight;
  }, [topHeight]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging || !containerRef.current) return;
    const containerHeight = containerRef.current.offsetHeight;
    const deltaY = e.clientY - dragStartY.current;
    const deltaPercent = (deltaY / containerHeight) * 100;
    const newHeight = Math.max(minTopHeight / containerHeight * 100, Math.min(maxTopHeight, dragStartHeight.current + deltaPercent));
    setTopHeight(newHeight);
    if (persistKey) {
      localStorage.setItem(`sm-vpanel-${persistKey}`, String(newHeight));
    }
  }, [isDragging, minTopHeight, maxTopHeight, persistKey]);

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
    <div ref={containerRef} className={cn('flex flex-col h-full w-full overflow-hidden', className)}>
      <div style={{ height: `${topHeight}%`, minHeight: minTopHeight }} className="overflow-hidden shrink-0">
        {children[0]}
      </div>
      <div
        onMouseDown={handleMouseDown}
        className={cn(
          'h-1 shrink-0 cursor-row-resize hover:bg-primary/30 active:bg-primary/50 transition-colors relative z-10',
          isDragging && 'bg-primary/40',
        )}
      >
        <div className="absolute inset-x-0 top-0 bottom-0 -my-1" />
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {children[1]}
      </div>
    </div>
  );
}
