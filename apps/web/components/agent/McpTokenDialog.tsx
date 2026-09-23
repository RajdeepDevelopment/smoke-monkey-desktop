'use client';

import { useState } from 'react';
import { ExternalLink, KeyRound, Loader2, ShieldCheck, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { api } from '../../lib/api';

export interface McpTokenDialogProps {
  open: boolean;
  server: { id: string; name: string; url?: string | null } | null;
  onClose: () => void;
  onSaved: () => void;
}

export function McpTokenDialog({ open, server, onClose, onSaved }: McpTokenDialogProps) {
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testOk, setTestOk] = useState<number | null>(null);

  const reset = () => {
    setToken('');
    setSaving(false);
    setError(null);
    setTestOk(null);
  };

  const host = server?.url ? (() => { try { return new URL(server.url).hostname; } catch { return null; } })() : null;

  const handleSave = async () => {
    if (!server) return;
    const value = token.trim();
    if (!value) {
      setError('Paste a personal access token / API key first.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.updateMcpServer(server.id, { apiToken: value });
      let tools = 0;
      try {
        const test = await api.testMcpServer(server.id);
        tools = test.tools?.length ?? 0;
        if (!test.ok) throw new Error(test.error || 'Test failed');
      } catch (testErr) {
        const msg = testErr instanceof Error ? testErr.message : String(testErr);
        if (msg.includes('not authorized') || msg.includes('401')) {
          setError('Token saved, but the server rejected it — double-check the value and try again.');
          setSaving(false);
          return;
        }
      }
      setTestOk(tools);
      onSaved();
      setTimeout(onClose, 900);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save token');
    } finally {
      if (testOk === null) setSaving(false);
    }
  };

  return (
    <Dialog
      open={open && !!server}
      onOpenChange={(next) => {
        if (!next) { reset(); onClose(); }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Connect via personal access token</DialogTitle>
          <DialogDescription className="text-[11px]">
            {host
              ? `${host} does not support automatic client registration.`
              : 'This server does not support automatic client registration.'}{' '}
            You can connect by pasting a personal access token / API key instead.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 space-y-3">
          <div>
            <label className="mb-1.5 block text-[11px] font-medium text-ink-muted">Personal access token / API key</label>
            <input
              autoFocus
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleSave(); }}
              placeholder={host === 'mcp.render.com' ? 'rnd_xxx… (Render API key)' : 'Bearer token / API key'}
              className="w-full rounded-md border border-slate-700/60 bg-slate-900/80 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
            />
          </div>

          <p className="text-[10px] leading-relaxed text-ink-muted/70">
            {host === 'mcp.render.com' ? (
              <>Create a Render API key at <a href="https://dashboard.render.com" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-violet-300 hover:underline">dashboard.render.com <ExternalLink className="inline h-2.5 w-2.5" /></a>, then paste it above.</>
            ) : host ? (
              <>Get a token from the provider&apos;s dashboard for <code className="font-mono text-violet-300/90">{host}</code>.</>
            ) : (
              <>Get a token from the server&apos;s dashboard or settings page.</>
            )}{' '}
            The token is sent as <code className="font-mono text-violet-300/90">Authorization: Bearer</code>.
          </p>

          {error && <p className="text-[11px] text-red-400">{error}</p>}
          {testOk !== null && (
            <div className="flex items-center gap-1.5 text-[11px] text-emerald-400">
              <ShieldCheck className="h-3.5 w-3.5" /> {testOk > 0 ? `Connected — ${testOk} tool${testOk === 1 ? '' : 's'} ready` : 'Saved'}
            </div>
          )}
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={saving} onClick={() => { reset(); onClose(); }}>
            <X className="h-3.5 w-3.5" /> Cancel
          </Button>
          <Button
            size="sm"
            disabled={saving || testOk !== null}
            onClick={() => void handleSave()}
            className="bg-violet-500/15 text-violet-300 hover:bg-violet-500/25"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
            {saving ? 'Saving…' : 'Save & connect'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
