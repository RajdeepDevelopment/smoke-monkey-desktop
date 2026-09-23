'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../components/AuthProvider';
import { AuthCard } from '../../components/auth/AuthCard';

export default function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      router.push('/');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-full w-full items-center justify-center px-4">
      {/* Magic UI backdrop — drifting aurora orbs */}
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-24 left-1/2 h-72 w-[36rem] -translate-x-1/2 rounded-full bg-primary/20 blur-[120px]" />
        <div className="absolute bottom-[-4rem] left-[-6rem] h-64 w-64 rounded-full bg-accent/10 blur-[100px]" />
        <div className="absolute right-[-5rem] top-1/3 h-64 w-64 rounded-full bg-primary-deep/15 blur-[110px]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_1px_1px,hsl(var(--border)/0.12)_1px,transparent_0)] bg-[size:44px_44px] opacity-40 [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]" />
      </div>

      <AuthCard
        title="Sign in to Smoke Monkey"
        subtitle="Your agentic AI harness to build, fix, answer, and create anything in your project."
        submitLabel="Sign in"
        submittingLabel="Signing in…"
        busy={busy}
        error={error}
        onSubmit={submit}
        fields={{
          name: { value: '', onChange: () => undefined },
          email: { value: email, onChange: setEmail },
          password: { value: password, onChange: setPassword },
        }}
        footer={{ href: '/register', label: "Don't have an account?", action: 'Create one' }}
      />
    </div>
  );
}