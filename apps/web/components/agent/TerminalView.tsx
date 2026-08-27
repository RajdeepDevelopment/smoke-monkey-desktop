'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import {
  Terminal as TerminalIcon,
  Plus,
  X,
  Circle,
  AlertTriangle,
  Shield,
  ShieldAlert,
  Info,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { API_URL, getToken, nativeFetch } from '../../lib/api';

// ── Tauri helpers ────────────────────────────────────────────────────────

function isTauri(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  );
}

let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
async function getInvoke() {
  if (_invoke) return _invoke;
  try {
    const mod = await import('@tauri-apps/api/core');
    _invoke = mod.invoke;
    return _invoke;
  } catch {
    return null;
  }
}

// ── Types ────────────────────────────────────────────────────────────────

interface TerminalTab {
  id: string;
  label: string;
  ptyId: string | null;
  cwd: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  pid: number | null;
}

interface ProcessInfo {
  id: string;
  pid: number;
  command: string;
  cwd: string;
  started_at: number;
  status: string;
  exit_code: number | null;
}

interface EnvInfo {
  os: string;
  arch: string;
  shell: string;
  node?: string;
  npm?: string;
  pnpm?: string;
  yarn?: string;
  python?: string;
  git?: string;
  docker?: string;
  docker_compose?: string;
  rust?: string;
  cargo?: string;
  java?: string;
  go?: string;
  cwd: string;
  home: string;
  username: string;
  hostname: string;
}

type RiskLevel = 'Safe' | 'Medium' | 'Dangerous';

// ── Port detection from output ───────────────────────────────────────────

const PORT_REGEX = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0)[:\s](\d{2,5})/g;
const LISTENING_REGEX = /(?:listening|LISTEN|bound to|started on) (?:on )?(?:.*?:)?(\d{2,5})/gi;

function detectPorts(text: string): number[] {
  const ports = new Set<number>();
  let match;
  while ((match = PORT_REGEX.exec(text)) !== null) {
    ports.add(parseInt(match[1], 10));
  }
  while ((match = LISTENING_REGEX.exec(text)) !== null) {
    const p = parseInt(match[1], 10);
    if (p > 0 && p < 65536) ports.add(p);
  }
  return Array.from(ports).sort((a, b) => a - b);
}

const WELL_KNOWN_PORTS: Record<number, string> = {
  3000: 'Next.js / React',
  3001: 'Next.js (alt)',
  4000: 'NestJS',
  5173: 'Vite',
  8000: 'Django / FastAPI',
  8080: 'HTTP Alt',
  5432: 'PostgreSQL',
  6379: 'Redis',
  27017: 'MongoDB',
  9229: 'Node Debug',
};

// ── Error extraction ─────────────────────────────────────────────────────

interface ParsedError {
  type: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  code?: string;
}

const ERROR_PATTERNS: Array<{ regex: RegExp; type: string }> = [
  { regex: /TS(\d{4})/g, type: 'typescript' },
  { regex: /Module not found: (.+)/g, type: 'module_not_found' },
  { regex: /ECONNREFUSED/g, type: 'connection_refused' },
  { regex: /EADDRINUSE.*?(\d+)/g, type: 'port_in_use' },
  { regex: /Cannot find module (.+)/g, type: 'module_not_found' },
  { regex: /SyntaxError: (.+)/g, type: 'syntax_error' },
  { regex: /Error: (.+)/g, type: 'generic_error' },
  { regex: /FATAL/g, type: 'fatal' },
  { regex: /panic/g, type: 'panic' },
];

function extractErrors(text: string): ParsedError[] {
  const errors: ParsedError[] = [];
  const lines = text.split('\n');
  for (const line of lines) {
    for (const { regex, type } of ERROR_PATTERNS) {
      regex.lastIndex = 0;
      const match = regex.exec(line);
      if (match) {
        const error: ParsedError = { type, message: line.trim() };
        if (type === 'typescript') error.code = match[1];
        if (type === 'module_not_found') error.file = match[1];
        errors.push(error);
      }
    }
  }
  return errors;
}

// ── Environment snapshot display ─────────────────────────────────────────

function EnvPanel({ env }: { env: EnvInfo | null }) {
  if (!env) return <div className="text-xs text-ink-muted p-3">Detecting environment...</div>;

  const items = [
    { label: 'OS', value: `${env.os} (${env.arch})` },
    { label: 'Shell', value: env.shell },
    { label: 'User', value: `${env.username}@${env.hostname}` },
    { label: 'Node', value: env.node },
    { label: 'npm', value: env.npm },
    { label: 'pnpm', value: env.pnpm },
    { label: 'yarn', value: env.yarn },
    { label: 'Python', value: env.python },
    { label: 'Git', value: env.git },
    { label: 'Docker', value: env.docker },
    { label: 'Rust', value: env.rust },
    { label: 'Cargo', value: env.cargo },
    { label: 'Java', value: env.java },
    { label: 'Go', value: env.go },
  ];

  return (
    <div className="p-3 space-y-1.5">
      <div className="text-xs font-medium text-foreground/80 mb-2">Environment</div>
      {items.map(({ label, value }) => (
        <div key={label} className="flex items-center justify-between text-xs">
          <span className="text-ink-muted">{label}</span>
          <span className={cn(
            'font-mono',
            value ? 'text-green-400' : 'text-ink-muted/50'
          )}>
            {value || 'not found'}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Process list display ─────────────────────────────────────────────────

function ProcessList({
  processes,
  onKill,
}: {
  processes: ProcessInfo[];
  onKill: (id: string) => void;
}) {
  if (processes.length === 0) {
    return (
      <div className="p-3 text-xs text-ink-muted">
        No active processes
      </div>
    );
  }

  return (
    <div className="p-2 space-y-1">
      <div className="text-xs font-medium text-foreground/80 px-1 mb-2">Processes</div>
      {processes.map((p) => (
        <div
          key={p.id}
          className="flex items-center justify-between px-2 py-1.5 rounded bg-surface-hover text-xs"
        >
          <div className="flex items-center gap-2 min-w-0">
            <Circle
              className={cn(
                'h-2 w-2 shrink-0',
                p.status === 'running' ? 'fill-green-500 text-green-500' :
                p.status === 'completed' ? 'fill-blue-500 text-blue-500' :
                'fill-red-500 text-red-500'
              )}
            />
            <span className="font-mono truncate">{p.command}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-ink-muted font-mono">PID {p.pid}</span>
            {p.status === 'running' && (
              <button
                onClick={() => onKill(p.id)}
                className="text-red-400 hover:text-red-300 p-0.5"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Permission dialog ────────────────────────────────────────────────────

function PermissionBanner({
  command,
  risk,
  onApprove,
  onDeny,
}: {
  command: string;
  risk: RiskLevel;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const color =
    risk === 'Dangerous' ? 'border-red-500/50 bg-red-500/5' :
    risk === 'Medium' ? 'border-yellow-500/50 bg-yellow-500/5' :
    'border-green-500/50 bg-green-500/5';

  const Icon =
    risk === 'Dangerous' ? ShieldAlert :
    risk === 'Medium' ? AlertTriangle :
    Shield;

  const iconColor =
    risk === 'Dangerous' ? 'text-red-400' :
    risk === 'Medium' ? 'text-yellow-400' :
    'text-green-400';

  return (
    <div className={cn('border rounded-lg p-3 m-2', color)}>
      <div className="flex items-center gap-2 mb-2">
        <Icon className={cn('h-4 w-4', iconColor)} />
        <span className="text-xs font-medium text-foreground/80">
          {risk === 'Dangerous' ? 'Dangerous Command' : 'Permission Required'}
        </span>
      </div>
      <code className="block text-xs font-mono text-foreground/60 bg-surface rounded px-2 py-1 mb-2">
        {command}
      </code>
      <div className="flex gap-2">
        <button
          onClick={onApprove}
          className="text-xs px-3 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90"
        >
          Allow
        </button>
        <button
          onClick={onDeny}
          className="text-xs px-3 py-1 rounded bg-surface text-foreground/60 hover:bg-surface-hover"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

// ── Port detector display ────────────────────────────────────────────────

function PortBadges({ ports }: { ports: number[] }) {
  if (ports.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {ports.map((port) => (
        <a
          key={port}
          href={`http://localhost:${port}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors"
          title={WELL_KNOWN_PORTS[port] || `localhost:${port}`}
        >
          <Circle className="h-1.5 w-1.5 fill-blue-400" />
          {port}
          {WELL_KNOWN_PORTS[port] && (
            <span className="text-blue-400/60 ml-0.5">{WELL_KNOWN_PORTS[port]}</span>
          )}
        </a>
      ))}
    </div>
  );
}

// ── Main TerminalView ────────────────────────────────────────────────────

interface Props {
  sessionId: string;
  workspacePath: string;
  className?: string;
  visible?: boolean;
}

export function TerminalView({ sessionId, workspacePath, className, visible = true }: Props) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [env, setEnv] = useState<EnvInfo | null>(null);
  const [showProcesses, setShowProcesses] = useState(false);
  const [showEnv, setShowEnv] = useState(false);
  const [detectedPorts, setDetectedPorts] = useState<number[]>([]);
  const [permissionRequest, setPermissionRequest] = useState<{
    command: string;
    risk: RiskLevel;
    resolve: (approve: boolean) => void;
  } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const termInstances = useRef<Map<string, Terminal>>(new Map());
  const fitAddons = useRef<Map<string, FitAddon>>(new Map());
  const lastFitDims = useRef<Map<string, { cols: number; rows: number }>>(new Map());
  const unlisteners = useRef<Array<() => void>>([]);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const disposedRef = useRef(false);

  // Latest tab state for callbacks that must stay referentially stable
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const workspaceRef = useRef(workspacePath);
  workspaceRef.current = workspacePath;

  // ── Fit helper: only resize when dimensions actually changed ─────────

  const fitTab = useCallback((tabId: string) => {
    const term = termInstances.current.get(tabId);
    const fitAddon = fitAddons.current.get(tabId);
    if (!term || !fitAddon) return;
    try {
      const proposed = fitAddon.proposeDimensions();
      if (!proposed) return;
      const last = lastFitDims.current.get(tabId);
      if (last && last.cols === proposed.cols && last.rows === proposed.rows) return;
      lastFitDims.current.set(tabId, { cols: proposed.cols, rows: proposed.rows });
      term.resize(proposed.cols, proposed.rows);
    } catch {}
  }, []);

  // ── Detect environment on mount ──────────────────────────────────────

  useEffect(() => {
    const detect = async () => {
      if (isTauri()) {
        const invoke = await getInvoke();
        if (invoke) {
          try {
            const snapshot = await invoke('detect_environment') as EnvInfo;
            setEnv(snapshot);
          } catch {}
        }
      } else {
        // Browser fallback: detect from user agent
        setEnv({
          os: navigator.platform,
          arch: 'unknown',
          shell: 'browser',
          cwd: workspacePath,
          home: '~',
          username: 'user',
          hostname: 'browser',
        });
      }
    };
    detect();
  }, []);

  // ── Refresh processes periodically ───────────────────────────────────

  useEffect(() => {
    if (!isTauri()) return;
    const refresh = async () => {
      const invoke = await getInvoke();
      if (!invoke) return;
      try {
        const list = await invoke('pty_list') as ProcessInfo[];
        setProcesses(list);
      } catch {}
    };
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, []);

  // ── Switch active tab ────────────────────────────────────────────────

  const switchTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);

    // Hide all xterm wrappers, show the active one
    if (!containerRef.current) return;
    const wrappers = containerRef.current.querySelectorAll('[id^="xterm-"]');
    wrappers.forEach((w) => {
      (w as HTMLElement).style.display = 'none';
    });
    const activeWrapper = containerRef.current.querySelector(`#xterm-${tabId}`);
    if (activeWrapper) {
      (activeWrapper as HTMLElement).style.display = 'block';
      // Fit after showing
      setTimeout(() => fitTab(tabId), 10);
    }
  }, [fitTab]);

  // ── Create new terminal tab ──────────────────────────────────────────

  const createTab = useCallback(async (cwdOverride?: string) => {
    if (!containerRef.current) return;
    const invoke = await getInvoke();
    if (!invoke) return;

    const tabId = `tab_${Date.now()}`;
    const label = `Terminal ${tabs.length + 1}`;
    // Terminals always start at the workspace root unless explicitly opened
    // somewhere else ("Open in Terminal" context menu).
    const spawnDir = cwdOverride || workspaceRef.current;

    const newTab: TerminalTab = {
      id: tabId,
      label,
      ptyId: null,
      cwd: spawnDir,
      status: 'running',
      pid: null,
    };

    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(tabId);

    // Create xterm instance
    const term = new Terminal({
      theme: {
        background: '#080C12',
        foreground: '#D5DEE9',
        cursor: '#A78BFA',
        cursorAccent: '#080C12',
        selectionBackground: '#37315A',
        black: '#080C12',
        red: '#F87171',
        green: '#7DCB7D',
        yellow: '#E8B36B',
        blue: '#82AAFF',
        magenta: '#C792EA',
        cyan: '#5FBFAF',
        white: '#D5DEE9',
        brightBlack: '#4B5A6B',
        brightRed: '#FFA198',
        brightGreen: '#A5E0A5',
        brightYellow: '#F5CE8E',
        brightBlue: '#A3C4FF',
        brightMagenta: '#DFBBFF',
        brightCyan: '#8ADFD1',
        brightWhite: '#F8FAFC',
      },
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10000,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    termInstances.current.set(tabId, term);
    fitAddons.current.set(tabId, fitAddon);

    // We'll open the terminal when the tab becomes visible

    // Spawn PTY
    if (isTauri()) {
      try {
        const ptyId = await invoke('pty_spawn', {
          cwd: spawnDir,
          shell: undefined,
          rows: 24,
          cols: 80,
        }) as string;

        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId ? { ...t, ptyId } : t
          )
        );

        const { listen } = await import('@tauri-apps/api/event');

        // PTY output → xterm
        const unlistenOut = await listen<{ id: string; data: string }>(
          'pty-output',
          (event) => {
            if (event.payload.id !== ptyId) return;
            const termInstance = termInstances.current.get(tabId);
            if (termInstance) {
              termInstance.write(event.payload.data);
              // Detect ports in output
              const ports = detectPorts(event.payload.data);
              if (ports.length > 0) {
                setDetectedPorts((prev) => {
                  const merged = new Set([...prev, ...ports]);
                  return Array.from(merged).sort((a, b) => a - b);
                });
              }
            }
          }
        );
        unlisteners.current.push(unlistenOut);

        // PTY exit
        const unlistenExit = await listen<{ id: string }>(
          'pty-exit',
          (event) => {
            if (event.payload.id !== ptyId) return;
            setTabs((prev) =>
              prev.map((t) =>
                t.id === tabId ? { ...t, status: 'completed' } : t
              )
            );
          }
        );
        unlisteners.current.push(unlistenExit);

        // Process exit
        const unlistenProcExit = await listen<{ id: string; exitCode: number | null }>(
          'pty-process-exit',
          (event) => {
            if (event.payload.id !== ptyId) return;
            setTabs((prev) =>
              prev.map((t) =>
                t.id === tabId
                  ? {
                      ...t,
                      status: event.payload.exitCode === 0 ? 'completed' : 'failed',
                    }
                  : t
              )
            );
          }
        );
        unlisteners.current.push(unlistenProcExit);

        // Open terminal in the container
        const wrapper = document.createElement('div');
        wrapper.id = `xterm-${tabId}`;
        wrapper.className = 'h-full w-full';
        wrapper.style.display = 'none';
        containerRef.current.appendChild(wrapper);
        term.open(wrapper);
        fitAddon.fit();

        // Set up keyboard input → PTY stdin (no local echo, let PTY handle it)
        term.onData((data) => {
          invoke('pty_write', { id: ptyId, data }).catch(() => {});
        });

        // Handle resize: xterm fit → keep PTY size in sync
        term.onResize(({ cols, rows }) => {
          invoke('pty_resize', { id: ptyId, cols, rows }).catch(() => {});
        });

      } catch (err) {
        term.writeln(
          `\x1b[31mFailed to spawn PTY: ${err instanceof Error ? err.message : err}\x1b[0m`
        );
      }
    } else {
      // Browser fallback: one-shot HTTP execution
      const wrapper = document.createElement('div');
      wrapper.id = `xterm-${tabId}`;
      wrapper.className = 'h-full w-full';
      wrapper.style.display = 'none';
      containerRef.current.appendChild(wrapper);
      term.open(wrapper);
      fitAddon.fit();

      term.writeln('\x1b[1;36m╔════════════════════════════════════════════╗\x1b[0m');
      term.writeln('\x1b[1;36m║         Smoke Monkey Terminal              ║\x1b[0m');
      term.writeln('\x1b[1;36m╚════════════════════════════════════════════╝\x1b[0m');
      term.writeln('');
      term.writeln('\x1b[2m  Mode:    HTTP (browser fallback)\x1b[0m');
      term.writeln(`\x1b[2m  CWD:     ${workspacePath}\x1b[0m`);
      term.writeln('');

      let currentLine = '';
      const history: string[] = [];
      let historyIndex = -1;

      term.onData((data) => {
        // For browser mode, handle locally
        if (data === '\r') {
          term.writeln('');
          if (currentLine.trim()) {
            history.push(currentLine);
            historyIndex = history.length;
            executeBrowserCommand(currentLine.trim(), term, workspacePath);
          }
          currentLine = '';
        } else if (data === '\x7f') {
          if (currentLine.length > 0) {
            currentLine = currentLine.slice(0, -1);
            term.write('\b \b');
          }
        } else if (data === '\x03') {
          term.writeln('^C');
          currentLine = '';
          term.write('\x1b[1;32m$\x1b[0m ');
        } else if (data.length === 1 && data >= ' ') {
          currentLine += data;
          term.write(data);
        }
      });
    }

    // Show the new tab immediately (wrappers are created hidden)
    setTimeout(() => switchTab(tabId), 0);
  }, [tabs.length, switchTab]);

  // ── "Open in Terminal" requests from the file explorer ────────────────

  useEffect(() => {
    const onOpen = (e: Event) => {
      const cwd = (e as CustomEvent<{ cwd?: string }>).detail?.cwd;
      if (cwd) void createTab(cwd);
    };
    window.addEventListener('sm-open-terminal', onOpen);
    return () => window.removeEventListener('sm-open-terminal', onOpen);
  }, [createTab]);

  // ── Kill a process ───────────────────────────────────────────────────

  const killProcess = useCallback(async (id: string) => {
    if (!isTauri()) return;
    const invoke = await getInvoke();
    if (!invoke) return;
    try {
      await invoke('pty_kill', { id });
      setTabs((prev) =>
        prev.map((t) =>
          t.ptyId === id ? { ...t, status: 'killed' } : t
        )
      );
    } catch {}
  }, []);

  // ── Close a tab ──────────────────────────────────────────────────────

  const closeTab = useCallback(async (tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (tab?.ptyId) {
      await killProcess(tab.ptyId);
    }

    // Remove xterm wrapper
    const wrapper = containerRef.current?.querySelector(`#xterm-${tabId}`);
    wrapper?.remove();

    // Dispose xterm
    const term = termInstances.current.get(tabId);
    term?.dispose();
    termInstances.current.delete(tabId);
    fitAddons.current.delete(tabId);
    lastFitDims.current.delete(tabId);

    setTabs((prev) => {
      const filtered = prev.filter((t) => t.id !== tabId);
      if (activeTabId === tabId) {
        const newActive = filtered[filtered.length - 1]?.id || null;
        setActiveTabId(newActive);
        if (newActive) {
          setTimeout(() => switchTab(newActive), 10);
        }
      }
      return filtered;
    });
  }, [tabs, activeTabId, killProcess, switchTab]);

  // ── Handle visibility and resize ─────────────────────────────────────

  useEffect(() => {
    if (!visible) return;

    resizeObserverRef.current = new ResizeObserver(() => {
      if (activeTabId) {
        fitTab(activeTabId);
      }
    });

    if (containerRef.current) {
      resizeObserverRef.current.observe(containerRef.current);
    }

    return () => {
      resizeObserverRef.current?.disconnect();
    };
  }, [visible, activeTabId]);

  // ── Create first tab automatically (only once a workspace is known) ───

  useEffect(() => {
    if (visible && tabs.length === 0 && workspacePath && !disposedRef.current) {
      createTab();
    }
  }, [visible, tabs.length, workspacePath, createTab]);

  // ── Cleanup on unmount ───────────────────────────────────────────────

  useEffect(() => {
    return () => {
      disposedRef.current = true;

      // Kill all PTY sessions
      if (isTauri()) {
        getInvoke().then((invoke) => {
          if (invoke) invoke('pty_kill_all').catch(() => {});
        });
      }

      // Unlisten events
      unlisteners.current.forEach((unlisten) => unlisten());
      unlisteners.current = [];

      // Dispose all xterm instances
      termInstances.current.forEach((term) => term.dispose());
      termInstances.current.clear();
      fitAddons.current.clear();
    };
  }, []);

  if (!visible) return null;

  return (
    <div className={cn('flex flex-col h-full bg-[#080C12]', className)}>
      {/* Tab bar */}
      <div className="flex items-center border-b border-border bg-[#080C12]">
        <div className="flex items-center overflow-x-auto flex-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => switchTab(tab.id)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs border-r border-border min-w-0 max-w-[160px]',
                activeTabId === tab.id
                  ? 'bg-[#0D131C] text-foreground'
                  : 'text-foreground/50 hover:text-foreground/70 hover:bg-surface'
              )}
            >
              <Circle
                className={cn(
                  'h-2 w-2 shrink-0',
                  tab.status === 'running' ? 'fill-green-500 text-green-500' :
                  tab.status === 'completed' ? 'fill-blue-500 text-blue-500' :
                  tab.status === 'killed' ? 'fill-yellow-500 text-yellow-500' :
                  'fill-red-500 text-red-500'
                )}
              />
              <span className="truncate">{tab.label}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                className="shrink-0 text-foreground/30 hover:text-foreground/70 p-0.5"
              >
                <X className="h-3 w-3" />
              </button>
            </button>
          ))}
          <button
            onClick={() => void createTab()}
            className="px-2 py-1.5 text-foreground/30 hover:text-foreground/70 hover:bg-surface transition-colors"
            title="New Terminal"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Status badges */}
        <div className="flex items-center gap-2 px-3 shrink-0">
          <PortBadges ports={detectedPorts} />
          <span className={cn(
            'text-[10px] px-1.5 py-0.5 rounded font-medium',
            isTauri()
              ? 'text-green-400 bg-green-500/10'
              : 'text-yellow-400 bg-yellow-500/10'
          )}>
            {isTauri() ? 'PTY' : 'HTTP'}
          </span>
        </div>

        {/* Panel toggles */}
        <div className="flex items-center border-l border-border px-1">
          <button
            onClick={() => setShowProcesses(!showProcesses)}
            className={cn(
              'p-1.5 rounded text-xs',
              showProcesses ? 'text-blue-400 bg-blue-500/10' : 'text-foreground/40 hover:text-foreground/70'
            )}
            title="Processes"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setShowEnv(!showEnv)}
            className={cn(
              'p-1.5 rounded text-xs',
              showEnv ? 'text-blue-400 bg-blue-500/10' : 'text-foreground/40 hover:text-foreground/70'
            )}
            title="Environment"
          >
            <TerminalIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Permission banner */}
      {permissionRequest && (
        <PermissionBanner
          command={permissionRequest.command}
          risk={permissionRequest.risk}
          onApprove={() => {
            permissionRequest.resolve(true);
            setPermissionRequest(null);
          }}
          onDeny={() => {
            permissionRequest.resolve(false);
            setPermissionRequest(null);
          }}
        />
      )}

      {/* Main area: terminal + side panels */}
      <div className="flex-1 flex min-h-0">
        {/* Terminal container */}
        <div ref={containerRef} className="flex-1 min-h-0" />

        {/* Side panels */}
        {(showProcesses || showEnv) && (
          <div className="w-64 border-l border-border bg-[#080C12] overflow-y-auto">
            {showProcesses && (
              <ProcessList
                processes={processes}
                onKill={killProcess}
              />
            )}
            {showEnv && <EnvPanel env={env} />}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Browser fallback command execution ───────────────────────────────────

async function executeBrowserCommand(
  command: string,
  term: Terminal,
  cwd: string,
) {
  term.writeln(`\x1b[2m$ ${command}\x1b[0m`);

  try {
    const token = getToken();
    const res = await nativeFetch(`${API_URL}/api/agent/terminal/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ command, cwd }),
    });
    if (!res.ok) {
      term.writeln(`\x1b[31mHTTP ${res.status}: ${res.statusText}\x1b[0m`);
    } else {
      const result = await res.json();
      if (result.stdout) {
        for (const line of result.stdout.split('\n')) {
          term.writeln(line);
        }
      }
      if (result.stderr) {
        term.writeln(`\x1b[31m${result.stderr}\x1b[0m`);
      }
      if (!result.stdout && !result.stderr) {
        term.writeln('\x1b[2m(no output)\x1b[0m');
      }
    }
  } catch (err) {
    term.writeln(`\x1b[31m${err instanceof Error ? err.message : String(err)}\x1b[0m`);
  }

  term.write('\x1b[1;32m$\x1b[0m ');
}
