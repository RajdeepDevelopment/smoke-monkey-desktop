'use client';

import { BrandIcon } from './BrandIcon';

/**
 * Full-screen brand loader shown during the very first app boot (auth /
 * session check). Smoke Monkey icon breathing in a soft purple glow with
 * concentric ripple rings and a shimmering progress hairline.
 */
export function BootLoader() {
  return (
    <div className="relative flex min-h-screen w-full flex-col items-center justify-center overflow-hidden bg-bg">
      {/* Magic UI aurora backdrop */}
      <div className="pointer-events-none absolute inset-0 bg-app-aurora" />
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-32 left-1/2 h-80 w-[42rem] -translate-x-1/2 rounded-full bg-primary/25 blur-[130px]" />
        <div className="absolute bottom-[-5rem] left-[-4rem] h-64 w-64 rounded-full bg-accent/10 blur-[110px]" />
        <div className="absolute right-[-5rem] top-1/3 h-64 w-64 rounded-full bg-primary-deep/20 blur-[120px]" />
      </div>

      {/* Icon medallion with ripple rings */}
      <div className="relative flex h-32 w-32 items-center justify-center">
        {/* Ripple rings */}
        <span className="absolute inset-0 rounded-full border border-primary/20 animate-loader-ring" style={{ animationDelay: '0ms' }} />
        <span className="absolute inset-0 rounded-full border border-primary/20 animate-loader-ring" style={{ animationDelay: '400ms' }} />
        <span className="absolute inset-0 rounded-full border border-primary/20 animate-loader-ring" style={{ animationDelay: '800ms' }} />

        {/* Soft outer glow */}
        <span className="absolute inset-4 rounded-full bg-primary/30 blur-2xl animate-loader-glow" />

        {/* Icon tile */}
        <span className="absolute inset-0 rounded-[2rem] border border-primary/25 bg-surface-900/70 shadow-glow-strong backdrop-blur-md" />
        <BrandIcon size={74} className="relative drop-shadow-[0_0_20px_rgba(139,92,246,0.7)] animate-loader-breathe" />
      </div>

      {/* Wordmark */}
      <div className="mt-8 select-none text-center">
        <h1 className="bg-gradient-to-br from-white via-white to-primary-hover bg-clip-text text-[22px] font-semibold tracking-tight text-transparent">
          Smoke Monkey
        </h1>
        <p className="mt-1.5 text-[11px] font-medium uppercase tracking-[0.28em] text-ink-muted">
          AI · Memory · Workspace
        </p>
      </div>

      {/* Shimmering progress hairline */}
      <div className="mt-9 h-[3px] w-44 overflow-hidden rounded-full bg-surface-800">
        <div className="h-full w-1/2 rounded-full bg-gradient-to-r from-primary/50 via-primary-hover to-accent/60 animate-loader-sweep" />
      </div>

      <p className="mt-4 text-[11px] text-ink-muted/70 animate-pulse-soft">
        Waking the monkey…
      </p>
    </div>
  );
}