'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../components/AuthProvider';
import { AuthCard } from '../../components/auth/AuthCard';

export default function RegisterPage() {
  const { register } = useAuth();
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register(email, name, password);
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
        title="Create your account"
        subtitle="Start building a personal AI workspace with RAG and Super Memory."
        showName
        submitLabel="Sign up"
        submittingLabel="Creating…"
        busy={busy}
        error={error}
        onSubmit={submit}
        fields={{
          name: { value: name, onChange: setName },
          email: { value: email, onChange: setEmail },
          password: { value: password, onChange: setPassword },
        }}
        footer={{ href: '/login', label: 'Already have an account?', action: 'Sign in' }}
      />
    </div>
  );
}
