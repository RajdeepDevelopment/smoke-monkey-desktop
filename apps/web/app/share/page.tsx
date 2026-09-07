'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  Link2,
  Link2Off,
  PackageOpen,
  RefreshCw,
  Rocket,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { ShareStatusDto, ShareConfigDto, TunnelStatusDto } from '@rag/contracts';
import { api } from '../../lib/api';
import { openExternalUrl } from '../../lib/external-links';
import { PageScroll } from '../../components/PageScroll';
import { PageHeader } from '../../components/PageHeader';
import { StatusBadge } from '../../components/StatusBadge';
import { useToast } from '../../components/Toast';
import { cn } from '../../lib/utils';

export default function SharePage() {
  const toast = useToast();

  const [status, setStatus] = useState<ShareStatusDto | null>(null);
  const [config, setConfig] = useState<ShareConfigDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Config form state
  const [formProject, setFormProject] = useState('');
  const [formAccountId, setFormAccountId] = useState('');
  const [formApiToken, setFormApiToken] = useState('');
  const [formHostname, setFormHostname] = useState('');
  const [formPagesProject, setFormPagesProject] = useState('');
  const [formOutputDir, setFormOutputDir] = useState('');
  const [deployOutput, setDeployOutput] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([api.getShareStatus(), api.getShareConfig()]);
      setStatus(s);
      setConfig(c);
      setFormProject(c.projectName);
      setFormAccountId(c.accountId ?? '');
      setFormHostname(c.tunnelHostname ?? '');
      setFormPagesProject(c.pagesProjectName ?? '');
      setFormOutputDir(c.outputDir);
    } catch {
      toast.error('Failed to load share status');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const startTunnel = async () => {
    setBusy('tunnel');
    try {
      const res = await api.startQuickTunnel();
      setStatus((s) => s ? { ...s, quickTunnel: res } : s);
      if (res.url) toast.success('Share link ready!');
      else if (res.error) toast.error(res.error);
      else toast.info('Tunnel starting…');
    } catch {
      toast.error('Failed to start tunnel');
    } finally {
      setBusy(null);
    }
  };

  const stopTunnel = async () => {
    setBusy('tunnel');
    try {
      const res = await api.stopQuickTunnel();
      setStatus((s) => s ? { ...s, quickTunnel: res } : s);
      toast.info('Tunnel stopped');
    } catch {
      toast.error('Failed to stop tunnel');
    } finally {
      setBusy(null);
    }
  };

  const startPersistent = async () => {
    setBusy('persistent');
    try {
      const res = await api.startPersistentTunnel();
      setStatus((s) => s ? { ...s, persistentTunnel: res } : s);
      toast.success('Persistent tunnel started');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start persistent tunnel');
    } finally {
      setBusy(null);
    }
  };

  const stopPersistent = async () => {
    setBusy('persistent');
    try {
      const res = await api.stopPersistentTunnel();
      setStatus((s) => s ? { ...s, persistentTunnel: res } : s);
      toast.info('Persistent tunnel stopped');
    } catch {
      toast.error('Failed to stop persistent tunnel');
    } finally {
      setBusy(null);
    }
  };

  const saveConfig = async () => {
    setBusy('config');
    try {
      await api.updateShareConfig({
        projectName: formProject.trim(),
        accountId: formAccountId.trim() || undefined,
        apiToken: formApiToken.trim() || undefined,
        tunnelHostname: formHostname.trim() || undefined,
        pagesProjectName: formPagesProject.trim() || undefined,
        outputDir: formOutputDir.trim() || undefined,
      });
      toast.success('Share settings saved');
      setFormApiToken('');
      load();
    } catch {
      toast.error('Failed to save settings');
    } finally {
      setBusy(null);
    }
  };

  const deploy = async () => {
    setBusy('deploy');
    setDeployOutput(null);
    try {
      const res = await api.deployToPages(formPagesProject.trim() || undefined);
      if (res.ok) {
        toast.success(res.url ? 'Deployed to Cloudflare Pages!' : 'Deploy complete');
        if (res.url) await openExternalUrl(res.url);
      } else {
        toast.error('Deploy failed');
      }
      setDeployOutput(res.error ?? res.output ?? null);
    } catch {
      toast.error('Deploy failed');
    } finally {
      setBusy(null);
    }
  };

  const wranglerLogin = async () => {
    setBusy('wrangler-login');
    try {
      toast.info('Opening Cloudflare authorization in your browser…');
      const res = await api.wranglerLogin();
      if (res.ok) {
        toast.success('Wrangler authorized — you can now deploy and issue Cloudflare commands.');
        load();
      } else {
        toast.error(res.error || 'Wrangler login failed');
      }
    } catch {
      toast.error('Wrangler login failed');
    } finally {
      setBusy(null);
    }
  };

  const wranglerLogout = async () => {
    setBusy('wrangler-logout');
    try {
      const res = await api.wranglerLogout();
      if (res.ok) toast.success('Logged out of Wrangler');
      else toast.error(res.error || 'Logout failed');
      load();
    } catch {
      toast.error('Wrangler logout failed');
    } finally {
      setBusy(null);
    }
  };

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success('Link copied to clipboard');
    } catch {
      toast.error('Copy failed');
    }
  };

  const qt = status?.quickTunnel;
  const pt = status?.persistentTunnel;

  return (
    <PageScroll>
      <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-4 py-5 pb-20 sm:px-6 sm:py-6">
        <PageHeader
          title="Share & Host"
          description="Host Smoke Monkey from your machine or deploy to Cloudflare, then share a link with anyone."
        />

        {/* Toolchain status */}
        <div className="mb-6 mt-6 flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs uppercase tracking-wider text-slate-400">Toolchain</span>
          <StatusBadge
            label={`cloudflared ${status?.cloudflaredVersion ? status.cloudflaredVersion.split(' ').pop() : ''}`}
            tone={status?.cloudflaredAvailable ? 'success' : 'error'}
          />
          <StatusBadge label="wrangler (npx)" tone={status?.wranglerAvailable ? 'success' : 'error'} />
          <StatusBadge
            label={status?.wranglerLoggedIn ? 'wrangler authorized' : 'wrangler not logged in'}
            tone={status?.wranglerLoggedIn ? 'success' : 'warning'}
          />
          {!status?.cloudflaredAvailable && (
            <span className="text-xs text-amber-300">
              Install with <code className="rounded bg-black/30 px-1 font-mono text-[11px]">brew install cloudflared</code>
            </span>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : (
          <div className="space-y-5 pb-8">
            {/* ── Quick share (local hosting) ───────────────────────────── */}
            <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 backdrop-blur-md">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
                    <Globe className="h-4 w-4 text-sky-400" />
                    Quick Share (live from your machine)
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-slate-400">
                    Creates a temporary Cloudflare exit tunnel to this computer so anyone with the link can
                    reach the running app. No account required. The link stays live while the tunnel runs.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={load}
                  disabled={!!busy}
                  className="rounded-lg border border-slate-700/60 p-2 text-slate-400 transition-colors hover:border-slate-600 hover:text-white disabled:opacity-50"
                  title="Refresh"
                >
                  <RefreshCw className={cn('h-4 w-4', busy === 'tunnel' && 'animate-spin')} />
                </button>
              </div>

              {qt?.running && qt.url ? (
                <div className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-emerald-400" />
                    <span className="text-sm font-medium text-emerald-300">Live · {qt.hostname}</span>
                    <StatusBadge label="shared" tone="success" />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-lg border border-slate-700/60 bg-black/30 px-3 py-2 font-mono text-xs text-white">
                      {qt.url}
                    </code>
                    <button
                      type="button"
                      onClick={() => copyLink(qt.url!)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700/60 px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
                    >
                      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                    <button
                      type="button"
                      onClick={() => openExternalUrl(qt.url!)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700/60 px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      Open
                    </button>
                    <button
                      type="button"
                      onClick={stopTunnel}
                      disabled={busy === 'tunnel'}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-red-500/15 px-3 py-2 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/25 disabled:opacity-50"
                    >
                      <Link2Off className="h-3.5 w-3.5" />
                      Stop sharing
                    </button>
                  </div>
                  <p className="mt-2 text-[11px] text-slate-500">
                    Started {qt.startedAt ? new Date(qt.startedAt).toLocaleTimeString() : 'recently'}.
                    The link stops working when this window closes sharing.
                  </p>
                </div>
              ) : (
                <div className="mt-4">
                  {qt?.error && (
                    <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-300">
                      {qt.error}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={startTunnel}
                    disabled={!!busy}
                    className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-sky-600 to-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-sky-500/20 transition-all hover:shadow-sky-500/40 hover:brightness-110 active:scale-95 disabled:opacity-50"
                  >
                    {busy === 'tunnel' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                    {busy === 'tunnel' ? 'Starting tunnel…' : 'Create share link'}
                  </button>
                </div>
              )}
            </section>

            {/* ── Persistent tunnel ─────────────────────────────────────── */}
            <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 backdrop-blur-md">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
                <Link2 className="h-4 w-4 text-violet-400" />
                Persistent tunnel <span className="text-[11px] font-normal text-slate-500">(your own domain)</span>
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-slate-400">
                Use a hostname you control (e.g. <code className="rounded bg-black/30 px-1 font-mono text-[11px]">app.example.com</code>) with a
                Cloudflare account. Requires <code className="rounded bg-black/30 px-1 font-mono text-[11px]">cloudflared tunnel login</code> once.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <input
                  value={formHostname}
                  onChange={(e) => setFormHostname(e.target.value)}
                  placeholder="app.example.com"
                  className="w-full max-w-xs rounded-lg border border-slate-700/60 bg-slate-900/80 px-3 py-2 font-mono text-sm text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                />
                {pt?.running ? (
                  <button
                    type="button"
                    onClick={stopPersistent}
                    disabled={busy === 'persistent'}
                    className="rounded-lg bg-red-500/15 px-3 py-2 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/25 disabled:opacity-50"
                  >
                    <Link2Off className="mr-1 inline h-3.5 w-3.5" />
                    Stop
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={startPersistent}
                    disabled={busy === 'persistent' || !formHostname.trim()}
                    className="rounded-lg border border-violet-500/40 bg-violet-500/10 px-3 py-2 text-xs font-medium text-violet-300 transition-colors hover:bg-violet-500/20 disabled:opacity-50"
                  >
                    {busy === 'persistent' ? <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" /> : <Link2 className="mr-1 inline h-3.5 w-3.5" />}
                    Start persistent
                  </button>
                )}
                <button
                  type="button"
                  onClick={saveConfig}
                  disabled={busy === 'config'}
                  className="rounded-lg border border-slate-700/60 px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-slate-500 hover:text-white disabled:opacity-50"
                >
                  Save hostname
                </button>
              </div>
              {pt?.running && pt.url && (
                <div className="mt-3 flex items-center gap-2">
                  <span className="text-xs text-emerald-300">Live at</span>
                  <code className="truncate rounded-lg border border-slate-700/60 bg-black/30 px-2 py-1 font-mono text-xs text-white">
                    {pt.url}
                  </code>
                  <button type="button" onClick={() => copyLink(pt.url!)} className="text-slate-400 hover:text-white">
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </section>

            {/* ── Deploy to Cloudflare Pages ────────────────────────────── */}
            <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 backdrop-blur-md">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
                <Rocket className="h-4 w-4 text-orange-400" />
                Deploy static site to Cloudflare Pages
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-slate-400">
                Upload the built web app (<code className="rounded bg-black/30 px-1 font-mono text-[11px]">apps/web/out</code>)
                to a permanent Pages project. Authorize either with <em>Wrangler login</em> (OAuth — just a browser
                click) or an API token with <em>Pages: Edit</em> permission.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {status?.wranglerLoggedIn ? (
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs font-medium text-emerald-300">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    Wrangler authorized
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={wranglerLogin}
                    disabled={busy === 'wrangler-login' || !status?.wranglerAvailable}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-orange-500/40 bg-orange-500/10 px-3 py-2 text-xs font-medium text-orange-300 transition-colors hover:bg-orange-500/20 disabled:opacity-50"
                    title="Opens your browser to authorize Cloudflare via Wrangler (OAuth)"
                  >
                    {busy === 'wrangler-login' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
                    {busy === 'wrangler-login' ? 'Waiting for authorization…' : 'Log in with Wrangler'}
                  </button>
                )}
                {status?.wranglerLoggedIn && (
                  <button
                    type="button"
                    onClick={wranglerLogout}
                    disabled={busy === 'wrangler-logout'}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700/60 px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-slate-500 hover:text-white disabled:opacity-50"
                  >
                    {busy === 'wrangler-logout' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                    Log out
                  </button>
                )}
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Project name</label>
                  <input
                    value={formPagesProject || formProject}
                    onChange={(e) => setFormPagesProject(e.target.value)}
                    placeholder="smoke-monkey"
                    className="w-full rounded-lg border border-slate-700/60 bg-slate-900/80 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Output directory</label>
                  <input
                    value={formOutputDir}
                    onChange={(e) => setFormOutputDir(e.target.value)}
                    placeholder="/path/to/apps/web/out"
                    className="w-full rounded-lg border border-slate-700/60 bg-slate-900/80 px-3 py-2 font-mono text-sm text-white placeholder:text-slate-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Account ID (optional)</label>
                  <input
                    value={formAccountId}
                    onChange={(e) => setFormAccountId(e.target.value)}
                    placeholder="dash.cloudflare.com → account"
                    className="w-full rounded-lg border border-slate-700/60 bg-slate-900/80 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">API token</label>
                  <input
                    value={formApiToken}
                    onChange={(e) => setFormApiToken(e.target.value)}
                    type="password"
                    placeholder={config?.hasApiToken ? '•••••••• (stored)' : 'CLOUDFLARE_API_TOKEN'}
                    className="w-full rounded-lg border border-slate-700/60 bg-slate-900/80 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                  />
                </div>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={saveConfig}
                  disabled={busy === 'config'}
                  className="rounded-lg border border-slate-700/60 px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-slate-500 hover:text-white disabled:opacity-50"
                >
                  Save credentials
                </button>
                <button
                  type="button"
                  onClick={deploy}
                  disabled={busy === 'deploy'}
                  className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-orange-600 to-amber-600 px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-orange-500/20 transition-all hover:shadow-orange-500/40 hover:brightness-110 active:scale-95 disabled:opacity-50"
                >
                  {busy === 'deploy' ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageOpen className="h-4 w-4" />}
                  {busy === 'deploy' ? 'Deploying…' : 'Deploy to Pages'}
                </button>
              </div>
              {deployOutput && (
                <div className="mt-4">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-slate-400">Deploy output</p>
                    <button type="button" onClick={() => setDeployOutput(null)} className="text-slate-500 hover:text-white">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <pre className="mt-2 max-h-48 overflow-auto rounded-xl border border-slate-800 bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-slate-300">
                    {deployOutput}
                  </pre>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </PageScroll>
  );
}