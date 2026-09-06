'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Plus, Trash2, Plug, PlugZap,
  Loader2, Monitor, Server, CheckCircle2,
} from 'lucide-react';
import { sshApi, type SshProfile, type SshAuthMethod, type CreateSshProfileInput } from '../../lib/ssh-api';
import { cn } from '../../lib/utils';

interface Props {
  className?: string;
  /** Id of the profile currently driving the whole IDE (remote mode). */
  activeProfileId?: string | null;
  /** Invoked when the user connects to a host — flips the entire IDE to remote. */
  onConnect?: (profile: SshProfile) => void;
  /** Invoked when the user disconnects — back to the local workspace. */
  onDisconnect?: () => void;
}

function AuthMethodBadge({ method }: { method: SshAuthMethod }) {
  const map: Record<SshAuthMethod, string> = { key: 'key', password: 'pass', agent: 'agent' };
  return (
    <span className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-[9px] text-ink-muted">{map[method]}</span>
  );
}

const EMPTY_FORM: CreateSshProfileInput = {
  name: '', host: '', port: 22, username: 'root', authMethod: 'key',
  privateKey: '', password: '', remoteHome: '~', strictHostKey: false,
};

/** Connection manager for Remote-SSH. Connecting here switches the ENTIRE IDE
 *  (Explorer, Agent chat, terminal) to the remote host — it is NOT a disjoint
 *  mini file-browser. Managing profiles/keys/testing lives here; the active
 *  connection is owned by the parent (page.tsx) via onConnect/onDisconnect. */
export function SshPanel({ className, activeProfileId, onConnect, onDisconnect }: Props) {
  const [profiles, setProfiles] = useState<SshProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<CreateSshProfileInput>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; detail?: string } | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setProfiles(await sshApi.listProfiles());
    } catch (e: any) {
      setError(e?.message || 'Failed to load SSH profiles');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async () => {
    setSaving(true);
    setError(null);
    try {
      await sshApi.createProfile(form);
      setForm(EMPTY_FORM);
      setShowForm(false);
      await load();
    } catch (e: any) {
      setError(e?.message || 'Failed to save profile');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await sshApi.deleteProfile(id);
      if (activeProfileId === id) onDisconnect?.();
      await load();
    } catch (e: any) {
      setError(e?.message || 'Failed to delete profile');
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    setTestResult(null);
    try {
      const res = await sshApi.testProfile(id);
      setTestResult({ id, ...res });
    } catch (e: any) {
      setTestResult({ id, ok: false, detail: e?.message || 'test failed' });
    } finally {
      setTestingId(null);
    }
  };

  const handleConnect = async (profile: SshProfile) => {
    setConnectingId(profile.id);
    setError(null);
    try {
      // Verify reachability before flipping the whole IDE to remote.
      const res = await sshApi.testProfile(profile.id);
      if (!res.ok) {
        setTestResult({ id: profile.id, ok: false, detail: res.detail });
        setConnectingId(null);
        return;
      }
      onConnect?.(profile);
    } catch (e: any) {
      setTestResult({ id: profile.id, ok: false, detail: e?.message || 'connect failed' });
    } finally {
      setConnectingId(null);
    }
  };

  const connectedProfile = profiles.find((p) => p.id === activeProfileId) || null;

  return (
    <div className={cn('flex h-full flex-col overflow-hidden', className)}>
      {/* Header */}
      <div className="glass-border-bottom flex h-9 shrink-0 items-center justify-between px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
          Remote-SSH
        </span>
        <button onClick={() => { setShowForm((v) => !v); setError(null); }}
          className="glass-hover rounded p-1 text-ink-muted transition-colors hover:text-foreground" title="New SSH connection">
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Current connection banner */}
      {connectedProfile && (
        <div className="flex items-center gap-2 border-b border-green-500/20 bg-green-500/5 px-3 py-2">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-400" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] font-medium text-green-300">{connectedProfile.name}</p>
            <p className="truncate font-mono text-[9px] text-ink-muted">
              {connectedProfile.username}@{connectedProfile.host}:{connectedProfile.port}
            </p>
          </div>
          <button onClick={onDisconnect}
            className="shrink-0 rounded-md bg-red-500/15 px-2 py-1 text-[10px] font-medium text-red-300 transition-colors hover:bg-red-500/25">
            Disconnect
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        {/* Error banner */}
        {error && (
          <div className="mx-2 mt-2 rounded bg-red-500/10 px-2 py-1.5 text-[10px] text-red-300">{error}</div>
        )}

        {/* Create form */}
        {showForm && (
          <div className="glass-panel mx-2 mt-2 space-y-2 rounded-lg p-2.5">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Connection name (e.g. prod-server)"
              className="glass-panel w-full rounded-md px-2 py-1.5 text-xs outline-none placeholder:text-ink-muted/50 focus:ring-1 focus:ring-ring" />
            <div className="grid grid-cols-3 gap-1.5">
              <input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })}
                placeholder="host" className="col-span-2 glass-panel rounded-md px-2 py-1.5 text-xs outline-none placeholder:text-ink-muted/50 focus:ring-1 focus:ring-ring" />
              <input value={String(form.port ?? 22)} onChange={(e) => setForm({ ...form, port: Number(e.target.value) || 22 })}
                placeholder="22" type="number" className="glass-panel rounded-md px-2 py-1.5 text-xs outline-none placeholder:text-ink-muted/50 focus:ring-1 focus:ring-ring" />
            </div>
            <input value={form.username || 'root'} onChange={(e) => setForm({ ...form, username: e.target.value })}
              placeholder="username" className="glass-panel w-full rounded-md px-2 py-1.5 text-xs outline-none placeholder:text-ink-muted/50 focus:ring-1 focus:ring-ring" />
            <input value={form.remoteHome || '~'} onChange={(e) => setForm({ ...form, remoteHome: e.target.value })}
              placeholder="Remote folder (e.g. /home/user/project or ~/project)"
              className="glass-panel w-full rounded-md px-2 py-1.5 text-xs outline-none placeholder:text-ink-muted/50 focus:ring-1 focus:ring-ring" />
            <div className="flex gap-1">
              {(['key', 'password', 'agent'] as SshAuthMethod[]).map((m) => (
                <button key={m} onClick={() => setForm({ ...form, authMethod: m })}
                  className={cn('rounded-md px-2 py-1 text-[10px] transition-colors',
                    form.authMethod === m ? 'bg-primary text-primary-foreground' : 'glass-panel text-ink-muted glass-hover')}>
                  {m}
                </button>
              ))}
            </div>
            {form.authMethod === 'key' && (
              <textarea value={form.privateKey || ''} onChange={(e) => setForm({ ...form, privateKey: e.target.value })}
                placeholder="Private key (PEM / OpenSSH format)" rows={4}
                className="glass-panel w-full rounded-md px-2 py-1.5 text-[10px] font-mono outline-none placeholder:text-ink-muted/50 focus:ring-1 focus:ring-ring" />
            )}
            {form.authMethod === 'password' && (
              <input value={form.password || ''} onChange={(e) => setForm({ ...form, password: e.target.value })}
                type="password" placeholder="Password" className="glass-panel w-full rounded-md px-2 py-1.5 text-xs outline-none placeholder:text-ink-muted/50 focus:ring-1 focus:ring-ring" />
            )}
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-1.5 text-[10px] text-ink-muted">
                <input type="checkbox" checked={form.strictHostKey}
                  onChange={(e) => setForm({ ...form, strictHostKey: e.target.checked })} />
                Strict host key
              </label>
              <div className="flex gap-1.5">
                <button onClick={() => { setShowForm(false); setError(null); }}
                  className="px-2 py-1 text-[10px] text-ink-muted hover:text-foreground">Cancel</button>
                <button onClick={handleCreate} disabled={saving || !form.host || !form.name}
                  className="rounded-md bg-primary px-2.5 py-1 text-[10px] font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-50">
                  {saving ? 'Saving...' : 'Connect'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Profile list */}
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-1.5">
          {loading && <div className="p-3 text-center text-[10px] text-ink-muted">Loading...</div>}
          {!loading && profiles.length === 0 && (
            <div className="flex flex-col items-center justify-center px-4 py-10 text-ink-muted">
              <Plug className="mb-2 h-6 w-6 opacity-30" />
              <p className="text-[10px]">No SSH connections yet.</p>
              <button onClick={() => setShowForm(true)} className="mt-2 text-[10px] text-primary hover:underline">
                + Add connection
              </button>
            </div>
          )}
          {profiles.map((p) => (
            <SshProfileRow key={p.id} profile={p} connected={p.id === activeProfileId}
              connecting={connectingId === p.id}
              testResult={testResult?.id === p.id ? testResult : null}
              testing={testingId === p.id}
              onConnect={() => void handleConnect(p)}
              onDisconnect={() => onDisconnect?.()}
              onTest={() => handleTest(p.id)}
              onDelete={() => handleDelete(p.id)} />
          ))}
        </div>

        {/* Helper hint */}
        {!connectedProfile && profiles.length > 0 && (
          <div className="border-t border-white/5 px-3 py-2.5">
            <p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-ink-muted">
              <Server className="mt-0.5 h-3 w-3 shrink-0 opacity-60" />
              Connect to a host to open it as your workspace — the Explorer, agent and terminal all switch to the remote machine.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function SshProfileRow({
  profile, connected, connecting, testResult, testing, onConnect, onDisconnect, onTest, onDelete,
}: {
  profile: SshProfile;
  connected: boolean;
  connecting: boolean;
  testResult: { ok: boolean; detail?: string } | null;
  testing: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onTest: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="mb-1">
      <div
        className={cn(
          'flex w-full items-center gap-2 rounded-md bg-surface/40 px-2 py-2 text-left',
          connected ? 'border border-green-500/40 bg-green-500/5' : 'border border-transparent',
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {connected ? (
              <Monitor className="h-3.5 w-3.5 shrink-0 text-green-400" />
            ) : (
              <Plug className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
            )}
            <p className="truncate text-[11px] font-medium text-foreground/90">{profile.name}</p>
            <AuthMethodBadge method={profile.authMethod} />
            {connected && (
              <span className="rounded bg-green-500/15 px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wider text-green-300">Connected</span>
            )}
          </div>
          <p className="mt-0.5 truncate font-mono text-[9px] text-ink-muted">
            {profile.username}@{profile.host}:{profile.port}
            {profile.remoteHome ? ` · ${profile.remoteHome}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button onClick={onTest} disabled={testing} title="Test connection"
            className="rounded p-1 text-ink-muted transition-colors hover:text-green-400">
            {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <PlugZap className="h-3 w-3" />}
          </button>
          {connected ? (
            <button onClick={onDisconnect} title="Disconnect"
              className="rounded bg-red-500/15 px-2 py-1 text-[9px] font-medium text-red-300 transition-colors hover:bg-red-500/25">
              Disconnect
            </button>
          ) : (
            <button onClick={onConnect} disabled={connecting} title="Connect to host"
              className="rounded bg-primary px-2 py-1 text-[9px] font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-50">
              {connecting ? 'Connecting…' : 'Connect'}
            </button>
          )}
        </div>
        <button onClick={onDelete} title="Delete"
          className="shrink-0 rounded p-0.5 text-ink-muted/50 transition-colors hover:text-red-500">
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
      {testResult && (
        <div className={cn('mx-2 mt-1 rounded px-2 py-1 text-[10px]',
          testResult.ok ? 'bg-green-500/10 text-green-300' : 'bg-red-500/10 text-red-300')}>
          {testResult.ok ? '✓ Reachable' : `✕ ${testResult.detail || 'failed'}`}
        </div>
      )}
    </div>
  );
}
