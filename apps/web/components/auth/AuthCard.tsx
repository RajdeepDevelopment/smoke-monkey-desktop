'use client';

import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowRight, Eye, EyeOff, Loader2, Lock, Mail, Sparkles, TriangleAlert, User } from 'lucide-react';
import { BrandIcon } from '../BrandIcon';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

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

/** Shared premium auth form shell used by /login and /register — magic-UI
 *  glass panel: aurora wash, glow logo tile, gradient title, spotlight card,
 *  show/hide password, and a shimmering submit that fills to full-width. */
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
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; email?: string; password?: string }>({});

  const passwordHint = useMemo(
    () => (showName ? 'Min 8 characters — mix letters & numbers' : 'Enter your password to unlock'),
    [showName],
  );

  const validate = (): { name?: string; email?: string; password?: string } => {
    const errs: { name?: string; email?: string; password?: string } = {};
    const nameVal = fields.name.value.trim();
    const emailVal = fields.email.value.trim();
    const pw = fields.password.value;

    if (showName) {
      if (!nameVal) errs.name = 'Name is required';
      else if (nameVal.length < 2) errs.name = 'Name must be at least 2 characters';
      else if (nameVal.length > 50) errs.name = 'Name must be 50 characters or fewer';
    }

    if (!emailVal) errs.email = 'Email is required';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) errs.email = 'Enter a valid email address';
    else if (emailVal.length > 254) errs.email = 'Email is too long';

    if (!pw) errs.password = 'Password is required';
    else if (showName) {
      if (pw.length < 8) errs.password = 'Password must be at least 8 characters';
      else if (pw.length > 128) errs.password = 'Password is too long';
      else if (!/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) errs.password = 'Use a mix of letters and numbers';
    }
    return errs;
  };

  const clearFieldError = useCallback((key: 'name' | 'email' | 'password') => {
    setFieldErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  }, []);

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validate();
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;
    onSubmit(e);
  };

  return (
    <div className="w-full max-w-md animate-fade-up">
      {/* Glowing logo medallion */}
      <div className="relative mx-auto mb-7 flex h-20 w-20 items-center justify-center">
        <span className="absolute inset-0 rounded-3xl bg-primary/25 blur-2xl" />
        <span className="absolute inset-0 rounded-3xl border border-primary/30 bg-primary-subtle shadow-glow-strong" />
        <BrandIcon size={46} className="relative drop-shadow-[0_0_18px_rgba(139,92,246,0.55)]" />
        <span className="absolute -inset-3 rounded-full border border-primary/10 animate-pulse-soft" />
      </div>

      <div className="mb-7 text-center">
        <h1 className="bg-gradient-to-br from-white via-white to-primary-hover bg-clip-text text-[26px] font-semibold tracking-tight text-transparent">
          {title}
        </h1>
        <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-ink-muted">{subtitle}</p>
      </div>

      <Card className="relative overflow-hidden rounded-2xl border-border/80 bg-card/60 shadow-panel backdrop-blur-xl">
        {/* Magic UI spotlight + shimmer strip */}
        <span className="pointer-events-none absolute inset-x-0 -top-24 h-48 bg-primary-glow" />
        <span className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent" />
        <span className="pointer-events-none absolute inset-y-0 left-0 w-px bg-gradient-to-b from-transparent via-primary/30 to-transparent" />
        <span className="pointer-events-none absolute inset-y-0 right-0 w-px bg-gradient-to-b from-transparent via-accent/25 to-transparent" />

        <CardHeader className="space-y-1 px-6 pt-6 pb-0">
          <CardTitle className="inline-flex items-center gap-2 text-ink-primary">
            <Sparkles className="h-4 w-4 text-primary-hover" />
            {showName ? 'New workspace' : 'Welcome back'}
          </CardTitle>
          <CardDescription>{passwordHint}</CardDescription>
        </CardHeader>

        <form onSubmit={handleFormSubmit} noValidate>
          <CardContent className="space-y-4 px-6 py-5">
            {error && (
              <div
                role="alert"
                className="flex items-start gap-2.5 rounded-xl border border-error/25 bg-error-subtle px-3 py-2.5 text-sm text-red-300 animate-fade-in"
              >
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {showName && (
              <div className="space-y-1.5">
                <Label htmlFor="auth-name" className="text-[12.5px] text-ink-secondary">
                  Name
                </Label>
                <div className="relative">
                  <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
                  <Input
                    id="auth-name"
                    className={cn(
                      'h-11 bg-surface-950/70 pl-10 transition-shadow focus-visible:shadow-focus-ring',
                      fieldErrors.name && 'border-destructive/60 focus-visible:shadow-focus-ring',
                    )}
                    placeholder="How should we call you?"
                    value={fields.name.value}
                    onChange={(e) => {
                      fields.name.onChange(e.target.value);
                      clearFieldError('name');
                    }}
                    autoComplete="name"
                    maxLength={50}
                    disabled={busy}
                    required
                  />
                </div>
                {fieldErrors.name ? (
                  <p className="flex items-center gap-1 text-[11px] text-red-400 animate-fade-in">
                    <TriangleAlert className="h-3 w-3 shrink-0" /> {fieldErrors.name}
                  </p>
                ) : (
                  <p className="text-[10.5px] text-ink-muted/60">2–50 characters</p>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="auth-email" className="text-[12.5px] text-ink-secondary">
                Email
              </Label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
                <Input
                  id="auth-email"
                  type="email"
                  className={cn(
                    'h-11 bg-surface-950/70 pl-10 transition-shadow focus-visible:shadow-focus-ring',
                    fieldErrors.email && 'border-destructive/60 focus-visible:shadow-focus-ring',
                  )}
                  placeholder="you@example.com"
                  value={fields.email.value}
                  onChange={(e) => {
                    fields.email.onChange(e.target.value);
                    clearFieldError('email');
                  }}
                  autoComplete="email"
                  maxLength={254}
                  disabled={busy}
                  required
                />
              </div>
              {fieldErrors.email && (
                <p className="flex items-center gap-1 text-[11px] text-red-400 animate-fade-in">
                  <TriangleAlert className="h-3 w-3 shrink-0" /> {fieldErrors.email}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="auth-password" className="text-[12.5px] text-ink-secondary">
                Password
              </Label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
                <Input
                  id="auth-password"
                  type={showPassword ? 'text' : 'password'}
                  className={cn(
                    'h-11 bg-surface-950/70 pl-10 pr-10 transition-shadow focus-visible:shadow-focus-ring',
                    fieldErrors.password && 'border-destructive/60 focus-visible:shadow-focus-ring',
                  )}
                  placeholder={showName ? 'Min 8 characters' : '••••••••'}
                  value={fields.password.value}
                  onChange={(e) => {
                    fields.password.onChange(e.target.value);
                    clearFieldError('password');
                  }}
                  autoComplete={showName ? 'new-password' : 'current-password'}
                  minLength={showName ? 8 : undefined}
                  maxLength={128}
                  disabled={busy}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink-primary"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {fieldErrors.password && (
                <p className="flex items-center gap-1 text-[11px] text-red-400 animate-fade-in">
                  <TriangleAlert className="h-3 w-3 shrink-0" /> {fieldErrors.password}
                </p>
              )}
            </div>
          </CardContent>

          <CardFooter className="flex flex-col gap-2 px-6 pb-6 pt-0">
            <Button
              type="submit"
              size="lg"
              variant="glow"
              className="h-11 w-full rounded-xl text-[15px] font-semibold"
              disabled={busy}
            >
              {busy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {submittingLabel}
                </>
              ) : (
                <>
                  {submitLabel}
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </CardFooter>
        </form>
      </Card>

      <p className="mt-6 text-center text-sm text-ink-muted">
        {footer.label}{' '}
        <Link
          href={footer.href}
          className="font-medium text-primary-hover underline-offset-4 transition-colors hover:underline"
        >
          {footer.action}
        </Link>
      </p>
    </div>
  );
}