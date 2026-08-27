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
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <AuthCard
        title="Welcome back"
        subtitle="Sign in to chat with your documents and AI memory."
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
