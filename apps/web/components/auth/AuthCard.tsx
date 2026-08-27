'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Loader2, Lock, Mail, TriangleAlert, User } from 'lucide-react';
import { BrandIcon } from '../BrandIcon';
import { cn } from '../../lib/utils';

interface AuthCardProps {
  title: string;
  subtitle: string;
  showName?: boolean;
  submitLabel: string;
  submittingLabel: string;
  busy: boolean;
  error: string | null;
  onSubmit: (e: React.FormEvent) => void;
  fields: {
    name: { value: string; onChange: (v: string) => void };
    email: { value: string; onChange: (v: string) => void };
    password: { value: string; onChange: (v: string) => void };
  };
  footer: { href: string; label: string; action: string };
}

/** Shared premium auth form shell used by /login and /register. */
export function AuthCard({
  title,
  subtitle,
  showName,
  submitLabel,
  submittingLabel,
  busy,
  error,
  onSubmit,
  fields,
  footer,
}: AuthCardProps) {
  const inputCls = (invalid = false) =>
    cn(
      'input h-11 w-full pl-10 text-sm',
      invalid && 'border-error/60 focus:border-error focus:ring-error/20',
    );

  return (
    <div className="w-full max-w-md">
      <div className="mb-6 flex flex-col items-center text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-primary/25 bg-primary-subtle shadow-glow">
          <BrandIcon size={40} />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-primary">{title}</h1>
        <p className="mt-1.5 text-sm text-ink-muted">{subtitle}</p>
      </div>

      <form
        onSubmit={onSubmit}
        className="card space-y-4 p-6 shadow-2xl shadow-black/40 sm:p-7"
      >
        {error && (
          <div className="flex items-start gap-2.5 rounded-lg border border-error/25 bg-error-subtle px-3 py-2.5 text-sm text-red-300">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {showName && (
          <div className="relative">
            <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
            <input
              className={inputCls()}
              placeholder="Name"
              value={fields.name.value}
              onChange={(e) => fields.name.onChange(e.target.value)}
              autoComplete="name"
              required
            />
          </div>
        )}

        <div className="relative">
          <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
          <input
            className={inputCls()}
            type="email"
            placeholder="Email"
            value={fields.email.value}
            onChange={(e) => fields.email.onChange(e.target.value)}
            autoComplete="email"
            required
          />
        </div>

        <div className="relative">
          <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
          <input
            className={inputCls()}
            type="password"
            placeholder={showName ? 'Password (min 8 chars)' : 'Password'}
            value={fields.password.value}
            onChange={(e) => fields.password.onChange(e.target.value)}
            autoComplete={showName ? 'new-password' : 'current-password'}
            minLength={showName ? 8 : undefined}
            required
          />
        </div>

        <button type="submit" className="btn-primary h-11 w-full justify-center gap-2" disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {busy ? submittingLabel : submitLabel}
        </button>
      </form>

      <p className="mt-5 text-center text-sm text-ink-muted">
        {footer.label}{' '}
        <Link href={footer.href} className="font-medium text-accent hover:underline">
          {footer.action}
        </Link>
      </p>

      {!showName && (
        <p className="mt-4 rounded-lg border border-surface-800 bg-surface-900/40 px-3 py-2 text-center text-[11px] text-ink-muted">
          Demo: <code className="font-mono text-ink-secondary">demo@rag.local</code> /{' '}
          <code className="font-mono text-ink-secondary">demo-password-123</code>
        </p>
      )}
    </div>
  );
}
