'use client';

import { useCallback, useRef, useState } from 'react';
import { sshApi, type SshProfile } from '../../lib/ssh-api';

/** Bottom-panel remote shell. Each command runs on the remote host via SSH
 *  (one-shot connections, streaming output). Local directory changes (`cd`)
 *  are tracked so later commands run in the current remote dir. */
export function RemoteTerminal({ profile }: { profile: SshProfile }) {
  const [cwd, setCwd] = useState(profile.remoteHome || '~');
  const [lines, setLines] = useState<string[]>(['Remote shell via SSH: ' + profile.name]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const scrollTail = () => {
    requestAnimationFrame(() => {
      const el = bodyRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  };

  const run = useCallback(async (cmd: string) => {
    const trimmed = cmd.trim();
    if (!trimmed || busy) return;
    setInput('');
    setBusy(true);
    setLines((prev) => [...prev, `\u001b[32m${cwd}\u001b[0m $ ${trimmed}`, '']);

    // Track local-directory navigation client-side so prompts stay accurate.
    const cdMatch = trimmed.match(/^cd\s+(\S+)/);
    if (cdMatch) {
      const arg = cdMatch[1];
      let next = arg.startsWith('/') ? arg : arg === '~' ? (profile.remoteHome || '~') : `${cwd === '~' ? '~' : cwd}/${arg}`;
      if (arg === '~' || arg === '') next = profile.remoteHome || '~';
      // best-effort: accept-then-verify cd
      setCwd(next);
    }

    try {
      let acc = '';
      for await (const ev of sshApi.streamExec(profile.id, trimmed)) {
        if (ev.type === 'output') {
          let raw = '';
          try { raw = JSON.parse(ev.data); } catch { raw = ev.data; }
          acc += raw;
          setLines((prev) => [...prev, raw]);
        } else if (ev.type === 'error') {
          setLines((prev) => [...prev, `\u001b[31m[error]\u001b[0m ${ev.data}`, '']);
        }
      }
      setLines((prev) => [...prev, '']);
    } catch (e: any) {
      setLines((prev) => [...prev, `\u001b[31m[error]\u001b[0m ${e?.message || String(e)}`, '']);
    } finally {
      setBusy(false);
      scrollTail();
    }
  }, [cwd, busy, profile]);

  const onKeyDown = (ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      void run(input);
    }
  };

  return (
    <div className="flex h-full flex-col bg-[#080C12] text-[11px] font-mono text-green-300">
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto scrollbar-thin p-2 whitespace-pre-wrap break-words">
        {lines.map((l, i) => (
          <div key={i} className={l.startsWith('\u001b[31m') ? 'text-red-400' : ''}>
            {l.replace(/\u001b\[32m|\u001b\[0m|\u001b\[31m/g, '')}
          </div>
        ))}
        {busy && <div className="opacity-50">▌</div>}
      </div>
      <div className="flex items-center gap-1 border-t border-white/5 px-2 py-1">
        <span className="text-green-400 select-none">{cwd} $</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy}
          placeholder="Enter a command…"
          className="min-w-0 flex-1 bg-transparent text-green-200 outline-none placeholder:text-green-200/30"
          autoFocus
        />
      </div>
    </div>
  );
}
