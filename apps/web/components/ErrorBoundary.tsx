'use client';

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface ErrorBoundaryProps {
  fallback?: ReactNode;
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * Catches render/parse errors in markdown and visual widgets so a single
 * broken block can never crash the whole chat thread. Falls back to a
 * styled notice instead of unmounting the app.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('MarkdownRenderer crashed:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="my-3 rounded-lg border border-surface-600 bg-surface-900/60 p-3 text-xs text-ink-muted">
            This content could not be rendered.
          </div>
        )
      );
    }
    return this.props.children;
  }
}
