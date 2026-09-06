'use client';

import { memo, useState } from 'react';
import { Plug, PlugZap, Monitor, Check } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface RemoteConnectionState {
  /** null when the workspace is local. */
  profile: { id: string; name: string; host: string; username: string; port: number } | null;
  /** Whether a remote connection is active (i.e. profile selected). */
  connected: boolean;
  /** Saved SSH profiles available to connect to. */
  available: { id: string; name: string; host: string; username: string; port: number }[];
}

interface StatusBarProps {
  remote: RemoteConnectionState;
  onConnect: (profileId: string | null) => void;
  leftExtra?: React.ReactNode;
}

/**
 * VS Code-style status bar. The remote indicator sits bottom-left: green
 * "SSH: <host>" when connected to a remote host, grey "Local" otherwise.
 * Clicking it opens a "Connect to Host" menu.
 */
export const StatusBar = memo(function StatusBar({ remote, onConnect, leftExtra }: StatusBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  const active = remote.profile;
  const isRemote = remote.connected && !!active;

  return (
    <div className="glass-border-top relative z-20 flex h-5 shrink-0 select-none items-center gap-1 bg-[#0B0F17]/95 px-2 text-[10px] text-ink-muted">
      {/* Left: remote/local indicator */}
      <div className="relative">
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className={cn(
            'flex items-center gap-1.5 rounded px-1.5 py-0.5 transition-colors',
            isRemote ? 'text-emerald-300 hover:bg-white/[0.05]' : 'hover:bg-white/[0.05]',
          )}
          title={isRemote ? 'Connected — click to change or disconnect SSH host' : 'Local workspace — click to connect to an SSH host'}
        >
          {isRemote ? <PlugZap className="h-3 w-3" /> : <Plug className="h-3 w-3" />}
          <span className="font-medium">{isRemote ? `SSH: ${active!.name}` : 'Local'}</span>
        </button>

        {menuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
            <div className="absolute bottom-6 left-0 z-20 w-64 rounded-lg border glass-border bg-[#101522]/95 p-1 shadow-xl">
              <p className="px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-ink-muted/70">
                Connect to Host
              </p>
              {remote.available.length === 0 && (
                <p className="px-2 py-1.5 text-[10px] text-ink-muted">
                  No SSH connections. Add one from the SSH panel.
                </p>
              )}
              {remote.available.map((p) => (
                <button
                  key={p.id}
                  onClick={() => { onConnect(p.id); setMenuOpen(false); }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-white/[0.05]',
                    active?.id === p.id && 'text-foreground',
                  )}
                >
                  <Monitor className="h-3 w-3 shrink-0 text-ink-muted" />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <span className="shrink-0 font-mono text-[9px] text-ink-muted">{p.username}@{p.host}</span>
                  {active?.id === p.id && <Check className="h-3 w-3 shrink-0 text-primary" />}
                </button>
              ))}
              {remote.available.length > 0 && (
                <div className="my-1 border-t glass-border" />
              )}
              {isRemote && (
                <button
                  onClick={() => { onConnect(null); setMenuOpen(false); }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-red-300 transition-colors hover:bg-white/[0.05]"
                >
                  <Plug className="h-3 w-3" /> Disconnect from {active!.name}
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {leftExtra}

      {/* Right side */}
      <div className="ml-auto flex items-center gap-1">
        <span className="rounded px-1.5 py-0.5">
          {isRemote ? `ssh ${active!.username}@${active!.host}:${active!.port}` : 'Local workspace'}
        </span>
      </div>
    </div>
  );
});
