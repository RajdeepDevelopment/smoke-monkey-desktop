'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { IconType } from 'react-icons';
import {
  Send, Square, Loader2, Check, X, Copy, ExternalLink, ChevronDown, ChevronRight,
  MessageSquare, Bot, Wrench, FileText, Code2, History, Plus, KeyRound, Key,
  Search as SearchIcon, Terminal as TerminalIcon, PenLine, FilePlus2, Trash2,
  FlaskConical, GitBranch, FolderTree, FolderSearch, AlertCircle, Sparkles, Container,
  Layers, Paperclip, Zap, Brain, Plug,
  ChevronUp, ListChecks,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import type { AgentMessage, AgentEvent, AgentSession } from '../../lib/agent-api';
import { agentApi } from '../../lib/agent-api';
import {
  startRun as sessionStartRun,
  stopRun as sessionStopRun,
  subscribeAgentStore,
  getAgentStoreRev,
  getSessionLive,
  subscribeSessionEvents,
  clearLivePermission,
  clearLiveAskUser,
  clearLiveFreeSuggestion,
  clearLiveMcpStock,
  clearLiveMcpDecision,
  rejoinRun,
  type TodoItem,
} from '../../lib/agent-session-store';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { estimateTokens, estimateHistoryTokens, getModelCapabilities, formatTokens } from '../../lib/tokens';
import { requestNotificationPermission } from '../../lib/notifications';
import type { ModelProvider, UserKeyDto } from '@rag/contracts';
import { useWorkspace, type UiMode } from '../../hooks/useWorkspace';
import { ModelPicker } from '../chat/ModelPicker';
import { ResponsivePopover } from '../ui/responsive-popover';
import { AskUserDialog } from './AskUserDialog';
import { McpEnableDialog } from './McpEnableDialog';
import { McpAddDialog } from './McpAddDialog';
import { McpTokenDialog } from './McpTokenDialog';
import { McpStockInline, McpStockEntryInline } from './McpStockInline';
import { InlineDiff } from './InlineDiff';
import { AnsiText } from '../../lib/ansi';
import { BrandIcon } from '../BrandIcon';
import { resolveBrand, faviconForUrl, ApifyIcon, isApify, resolveServerIcon } from '../BrandIconResolver';
import { useMcpList } from '../../lib/mcp-store';
import { openExternalUrl } from '../../lib/external-links';
import { FileCard, FileCardPlaceholder } from '../visuals/FileCard';
import { splitAddons } from '../Markdown';
import { AddonShell } from '../visuals/AddonShell';
import { CardBlock, CardSkeleton, WidgetCard } from '../visuals/CardBlock';
import { ChartBlock, ChartSkeleton } from '../visuals/ChartBlock';
import { TreeBlock } from '../visuals/TreeBlock';
import { WorkflowBlock } from '../visuals/WorkflowBlock';
import { MermaidDiagram } from '../visuals/MermaidDiagram';
import { IsolatedHtml } from '../visuals/IsolatedHtml';
import { FileBasedViewer } from '../visuals/FileBasedViewer';
import { StreamingVisual } from '../visuals/StreamingVisual';

interface Props {
  sessionId: string;
  workspacePath: string;
  isRunning: boolean;
  onStatusChange: (running: boolean) => void;
  onFileSelect?: (path: string) => void;
  model?: string;
  provider?: string;
  onModelChange?: (provider: string, model: string) => void;
  injectedPrompt?: { text: string; nonce: number } | null;
  /** Chat-history toggle (header): recent chats dropdown above the conversation */
  sessions?: AgentSession[];
  activeSessionId?: string;
  onSelectSession?: (s: AgentSession) => void;
  onNewSession?: () => void;
  /** When set, the agent runs on this remote SSH profile. */
  remoteProfileId?: string;
  /** Overrides the workspace UI mode (defaults to the workspace's persisted mode). */
  mode?: UiMode;
}

/** One server row inside the `mcp.stock` event payload (mirrors the backend tool). */
interface McpStockEntry {
  id: string;
  name: string;
  label: string;
  description: string;
  category: string | null;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  url: string | null;
  icon: string | null;
  enabled: boolean;
  configured: boolean;
  oauthRegistered: boolean;
  oauthConnected: boolean;
  oauthExpiresAt: number | null;
  oauthExpired: boolean;
  envKeys: string[];
  activeInRun: boolean;
  /** true = already configured by the user; false = stock-catalog server not added yet. */
  added: boolean;
  keyGetUrl: string | null;
  keyGetLabel: string | null;
  dependency: string;
  remote: boolean;
  manualOAuth: boolean;
  oauthScopes: string | null;
  recommended: boolean;
  recommendedToEnable: boolean;
  recommendedToAdd: boolean;
  tags: string[];
}

interface McpStockPayload {
  query: string | null;
  category: string | null;
  task: string | null;
  categories: string[];
  servers: McpStockEntry[];
  recommendedIds: string[];
  recommendedToEnableIds: string[];
  recommendedToAddIds: string[];
  counts: {
    total: number;
    configured: number;
    added: number;
    enabled: number;
    active: number;
    needAttention: number;
    stockNotAdded: number;
    stockAdded: number;
    stockCategories: number;
  };
}

/** Whether a VS Code-family editor is installed — gates the "Open in IDE"
 *  button so it only shows when launching will actually succeed. */
async function checkIdeAvailable(): Promise<boolean> {
  try {
    if (window.__TAURI_INTERNALS__) {
      return Boolean(await window.__TAURI_INTERNALS__.invoke('ide_available'));
    }
  } catch {
    /* fall through */
  }
  return false;
}

/** Providers that require a user-uploaded API key (no env var fallback in production). */
const KEY_REQUIRED_PROVIDERS = new Set(['openrouter', 'nvidia', 'openai', 'xai', 'gemini', 'opencode']);

/** Providers/models that are free without needing a key (free OmniRoute mode). */
const FREE_PROVIDERS = new Set(['omniroute']);

/** Model IDs that represent the free / auto-routing tiers. */
const FREE_MODEL_SUGGESTIONS = ['big-pickle', 'auto/best-coding', 'auto/best-free'];

/** If a tool has been marked "running" in the UI for this long without a
 *  tool.completed/tool.failed event (dropped SSE, abandoned run, orphaned
 *  event), the UI watchdog marks it timed-out so it never spins forever. */
const TOOL_WATCHDOG_MS = 30_000;

/** Must match COMPACTION_THRESHOLD in run-context.ts — the backend fires
 *  compaction at this fraction of the context budget. */
const COMPACTION_THRESHOLD = 0.7;

// ── Tool metadata: semantic identity + activity grouping ──────────────────

type ToolFamily = 'inspect' | 'edit' | 'run' | 'verify' | 'git' | 'plan' | 'ask';

type ToolIcon = LucideIcon | IconType;

interface ToolMeta {
  label: string;
  icon: ToolIcon;
  family: ToolFamily;
  familyLabel: string;
  /** MCP server brand (e.g. Apify's spider). Populated for `server__tool` names. */
  brandIcon?: IconType;
  /** Tailwind text color for the server brand. */
  brandColor?: string;
  /** Server portion of an MCP `server__tool` name. */
  mcpServer?: string;
  /** Tool portion of an MCP `server__tool` name, kept raw so each tool stays specific. */
  toolShort?: string;
}

const TOOL_META: Record<string, ToolMeta> = {
  search_code: { label: 'Search', icon: SearchIcon, family: 'inspect', familyLabel: 'Inspecting' },
  grep: { label: 'Search', icon: SearchIcon, family: 'inspect', familyLabel: 'Inspecting' },
  glob: { label: 'Search', icon: SearchIcon, family: 'inspect', familyLabel: 'Inspecting' },
  find_symbol: { label: 'Find', icon: SearchIcon, family: 'inspect', familyLabel: 'Inspecting' },
  read_file: { label: 'Read', icon: FileText, family: 'inspect', familyLabel: 'Inspecting' },
  list_directory: { label: 'List', icon: FolderTree, family: 'inspect', familyLabel: 'Inspecting' },
  inspect: { label: 'Inspect', icon: FolderSearch, family: 'inspect', familyLabel: 'Inspecting' },
  docker_list: { label: 'Containers', icon: Container, family: 'inspect', familyLabel: 'Inspecting' },
  edit_file: { label: 'Edit', icon: PenLine, family: 'edit', familyLabel: 'Editing' },
  line_edit: { label: 'Edit', icon: PenLine, family: 'edit', familyLabel: 'Editing' },
  replace_lines: { label: 'Replace', icon: PenLine, family: 'edit', familyLabel: 'Editing' },
  apply_patch: { label: 'Patch', icon: FilePlus2, family: 'edit', familyLabel: 'Editing' },
  write_file: { label: 'Write', icon: FilePlus2, family: 'edit', familyLabel: 'Editing' },
  delete_file: { label: 'Delete', icon: Trash2, family: 'edit', familyLabel: 'Editing' },
  run_command: { label: 'Run', icon: TerminalIcon, family: 'run', familyLabel: 'Running' },
  docker_exec: { label: 'Run', icon: TerminalIcon, family: 'run', familyLabel: 'Running' },
  ssh_run: { label: 'Run', icon: TerminalIcon, family: 'run', familyLabel: 'Running' },
  run_test: { label: 'Test', icon: FlaskConical, family: 'verify', familyLabel: 'Verifying' },
  git_status: { label: 'Git status', icon: GitBranch, family: 'git', familyLabel: 'Git' },
  git_diff: { label: 'Diff', icon: GitBranch, family: 'git', familyLabel: 'Git' },
  git_log: { label: 'Log', icon: GitBranch, family: 'git', familyLabel: 'Git' },
  context_manage: { label: 'Context', icon: Layers, family: 'plan', familyLabel: 'Context' },
  inspect_mcp_stock: { label: 'MCP stock', icon: SearchIcon, family: 'inspect', familyLabel: 'Inspecting' },
  ask_user: { label: 'Ask', icon: MessageSquare, family: 'ask', familyLabel: 'Asking' },
  todo_write: { label: 'Plan', icon: ListChecks, family: 'plan', familyLabel: 'Planning' },
};

const FALLBACK_META: ToolMeta = { label: 'Tool', icon: Wrench, family: 'run', familyLabel: 'Running' };

/** Parses MCP-format tool names: "<serverName>__<toolName>". */
function parseMcpToolName(toolName: string): { serverName: string; toolName: string } | null {
  const sep = toolName.indexOf('__');
  if (sep <= 0) return null;
  return { serverName: toolName.slice(0, sep), toolName: toolName.slice(sep + 2) };
}

/** Splits a camelCase / snake_case / dash-case tool name into lowercase words. */
function toolTokens(toolName: string): string[] {
  return toolName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

interface McpTypeRule { tokens: string[]; icon: ToolIcon; label: string; family: ToolFamily; familyLabel: string }

/** Keyword rules (matched against tokenized tool names, most specific first) used
 *  to give each arbitrary MCP tool a distinct type identity + activity grouping. */
const MCP_TYPE_RULES: McpTypeRule[] = [
  {
    tokens: ['search', 'query', 'retrieve', 'retrieval', 'crawl', 'scrape', 'fetch', 'lookup', 'find', 'browse', 'navigate', 'web', 'http', 'link'],
    icon: SearchIcon,
    label: 'Search',
    family: 'inspect',
    familyLabel: 'Searching',
  },
  {
    tokens: ['read', 'list', 'get', 'open', 'preview', 'peek', 'describe', 'inspect', 'show', 'select', 'stats', 'meta', 'info', 'history', 'content', 'detail', 'ls'],
    icon: FileText,
    label: 'Read',
    family: 'inspect',
    familyLabel: 'Inspecting',
  },
  {
    tokens: ['write', 'set', 'update', 'upsert', 'insert', 'create', 'add', 'save', 'delete', 'remove', 'edit', 'modify', 'append', 'store', 'upload', 'overwrite', 'patch', 'rename', 'move', 'copy'],
    icon: PenLine,
    label: 'Write',
    family: 'edit',
    familyLabel: 'Editing',
  },
  {
    tokens: ['run', 'exec', 'execute', 'start', 'stop', 'restart', 'test', 'eval', 'invoke', 'call', 'send', 'post', 'publish', 'deploy', 'build', 'install', 'launch', 'command', 'bash', 'shell'],
    icon: TerminalIcon,
    label: 'Run',
    family: 'run',
    familyLabel: 'Running',
  },
];

/** Best-effort semantic type for an arbitrary MCP tool name. */
function mcpToolType(toolName: string): { icon: ToolIcon; label: string; family: ToolFamily; familyLabel: string } {
  const tokens = toolTokens(toolName);
  if (tokens.length === 0) {
    return { icon: Wrench, label: 'Tool', family: 'run', familyLabel: 'Running' };
  }
  for (const rule of MCP_TYPE_RULES) {
    if (tokens.some((t) => rule.tokens.includes(t))) {
      return { icon: rule.icon, label: rule.label, family: rule.family, familyLabel: rule.familyLabel };
    }
  }
  return { icon: Wrench, label: 'Tool', family: 'run', familyLabel: 'Running' };
}

function metaFor(name: string): ToolMeta {
  const builtin = TOOL_META[name];
  if (builtin) return builtin;

  const mcp = parseMcpToolName(name);
  if (mcp) {
    const type = mcpToolType(mcp.toolName);
    const brand = resolveBrand(mcp.serverName);
    return {
      label: type.label,
      icon: type.icon,
      family: type.family,
      familyLabel: type.familyLabel,
      brandIcon: brand.Icon,
      brandColor: brand.color,
      mcpServer: mcp.serverName,
      toolShort: mcp.toolName,
    };
  }

  return FALLBACK_META;
}

// ── Shared helpers ───────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="p-1 rounded-md hover:bg-muted/80 text-ink-muted hover:text-foreground transition-colors"
      title="Copy"
    >
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

/** Branded MCP server icon — real brand mark in its accent color on a dark tile. */
function McpServerIcon({ name, icon, dim }: { name: string; icon?: string | null; dim?: boolean }) {
  const { Icon: SrvIcon, color: srvColor, glyph } = resolveServerIcon(name, icon);
  if (isApify(name)) {
    return (
      <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center', dim && 'opacity-70')}>
        <ApifyIcon className="ml-0.5 h-5 w-5 text-[#F9AA25] drop-shadow-[0_0_7px_rgba(249,170,37,0.6)]" />
      </span>
    );
  }
  return (
    <span
      className={cn(
        'flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-surface-700 shadow-sm',
        dim && 'opacity-70',
      )}
    >
      {glyph ? (
        <span className="text-sm leading-none">{glyph}</span>
      ) : (
        <SrvIcon className={cn('h-3.5 w-3.5', srvColor)} />
      )}
    </span>
  );
}

/**
 * Premium markdown body. Rely on the shared `.md-body` token styles (spacing,
 * lists, headings, inline code) instead of stacked prose overrides, so
 * assistant answers read like a real chat — not bordered cards.
 */
function MarkdownRenderer({ content, onFileSelect }: { content: string; onFileSelect?: (path: string) => void }) {
  const segments = useMemo(() => splitAddons(content), [content]);
  return (
    <div className="md-body min-w-0 text-[13.5px]">
      {segments.map((seg, i) => {
        if (seg.kind === 'file') {
          return <FileCard key={i} path={seg.path} onOpenInEditor={onFileSelect} />;
        }
        if (seg.kind === 'streaming-file') {
          return <FileCardPlaceholder key={i} />;
        }
        if (seg.kind === 'card') return <CardBlock key={i} json={seg.json} />;
        if (seg.kind === 'streaming-card') return <CardSkeleton key={i} />;
        if (seg.kind === 'chart') return <ChartBlock key={i} kind={seg.sub} json={seg.json} />;
        if (seg.kind === 'tree') return <TreeBlock key={i} json={seg.json} />;
        if (seg.kind === 'workflow') return <WorkflowBlock key={i} json={seg.json} />;
        if (seg.kind === 'widget') return <WidgetCard key={i} hint={seg.hint} json={seg.json} />;
        if (seg.kind === 'widget-mermaid' || seg.kind === 'mermaid') {
          return <MermaidDiagram key={i} code={seg.code} />;
        }
        if (seg.kind === 'visuals') return <IsolatedHtml key={i} code={seg.code} />;
        if (seg.kind === 'files') {
          return (
            <FileBasedViewer
              key={i}
              files={seg.files}
              projectName={seg.projectName}
              metadata={seg.metadata}
            />
          );
        }
        if (seg.kind === 'streaming') {
          return (
            <AddonShell
              key={i}
              type="streaming"
              label={seg.lang === 'mermaid' ? 'Drawing diagram…' : 'Building visualization…'}
            >
              <div className="h-14 animate-pulse bg-surface-800/60" />
            </AddonShell>
          );
        }
        if (seg.kind === 'streamingVisuals') return <StreamingVisual key={i} code={seg.code} />;
        if (seg.kind === 'streamingFiles') {
          return (
            <FileBasedViewer
              key={i}
              files={seg.files}
              projectName={seg.projectName}
              metadata={seg.metadata}
              streaming
            />
          );
        }
        if (seg.kind === 'streamingMeta') {
          return (
            <AddonShell key={i} type="streaming" label="Parsing project…">
              <div className="h-14 animate-pulse bg-surface-800/60" />
            </AddonShell>
          );
        }
        if (seg.kind === 'streaming-widget') {
          return seg.widget === 'chart' ? <ChartSkeleton key={i} /> : <CardSkeleton key={i} />;
        }
        return (
          <ReactMarkdown
            key={i}
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={{
              pre: ({ children }) => {
                const child = children as React.ReactElement;
                if (child?.type === 'code') {
                  const lang = child.props?.className?.match(/language-(\w+)/)?.[1] || '';
                  const codeText = typeof child.props?.children === 'string'
                    ? child.props.children
                    : Array.isArray(child.props?.children)
                      ? child.props.children.map((c: any) => typeof c === 'string' ? c : c?.props?.children || '').join('')
                      : '';

                  if (lang === 'diff') {
                    return <InlineDiff diffText={codeText} />;
                  }

                  return (
                    <div className="group relative my-2.5 overflow-hidden rounded-lg border border-border bg-surface-950/80">
                      {lang && (
                        <div className="flex items-center justify-between border-b border-border/50 px-2.5 py-1">
                          <span className="text-[10px] text-ink-muted/80 font-mono">{lang}</span>
                          <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                            <CopyButton text={codeText} />
                          </div>
                        </div>
                      )}
                      <pre className="!my-0 !rounded-none !border-0 !bg-transparent !p-3">{children}</pre>
                    </div>
                  );
                }
                return <pre className="!my-2.5">{children}</pre>;
              },
              a: ({ href, children }) => {
                if (!href) return <a>{children}</a>;
                if (/^https?:\/\//i.test(href)) {
                  const fav = faviconForUrl(href);
                  if (fav) {
                    const FavIcon = fav.Icon;
                    return (
                      <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1">
                        <span className={cn('shrink-0 leading-none', fav.color)}>
                          <FavIcon className="h-3.5 w-3.5 fill-current" />
                        </span>
                        {children}
                      </a>
                    );
                  }
                  return (
                    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1">
                      <ExternalLink className="h-3 w-3 shrink-0 text-ink-muted/60" />
                      {children}
                    </a>
                  );
                }
                return <a href={href}>{children}</a>;
              },
            }}
          >
            {seg.content}
          </ReactMarkdown>
        );
      })}
    </div>
  );
}

// ── Tool call rendering: compact agent-action rows ──────────────────────

const FAMILY_LABELS: Record<ToolFamily, string> = {
  inspect: 'Inspecting',
  edit: 'Editing',
  run: 'Running',
  verify: 'Verifying',
  git: 'Git',
  plan: 'Planning',
  ask: 'Asking',
};

/** Per-family accent used for the tiny tool-type badge on MCP brand icons. */
const FAMILY_TINTS: Record<ToolFamily, string> = {
  inspect: 'text-sky-400',
  edit: 'text-amber-400',
  run: 'text-emerald-400',
  verify: 'text-teal-400',
  git: 'text-orange-400',
  plan: 'text-amber-400',
  ask: 'text-pink-400',
};

/** Short, human-readable target for a tool call (path, pattern, or command). */
function toolTarget(tc: { toolName: string; arguments: unknown }): string {
  const args = (typeof tc.arguments === 'object' && tc.arguments !== null ? tc.arguments : {}) as Record<string, unknown>;
  const first = (...keys: string[]) => {
    for (const k of keys) {
      const v = args[k];
      if (typeof v === 'string' && v) return v;
    }
    return undefined;
  };
  let t: string | undefined;
  if (tc.toolName === 'run_command' || tc.toolName === 'run_test' || tc.toolName === 'ssh_run' || tc.toolName === 'docker_exec') {
    t = first('command');
  } else if (tc.toolName === 'grep' || tc.toolName === 'search_code') {
    t = String(first('regex', 'pattern', 'query') ?? first('path', 'include') ?? '');
  } else if (tc.toolName === 'glob') {
    t = String(first('pattern', 'path') ?? '');
  } else if (tc.toolName === 'find_symbol') {
    t = String(first('symbol', 'name', 'query') ?? '');
  } else if (tc.toolName === 'ask_user') {
    t = String(first('question') ?? '');
  } else {
    // MCP + arbitrary tools: grab the most meaningful short string argument.
    t = String(
      first('path', 'filePath', 'relativePath', 'file', 'url', 'uri', 'query', 'query_string', 'search',
        'question', 'prompt', 'message', 'input', 'sql', 'command', 'name', 'id', 'symbol', 'pattern',
        'key', 'value', 'repo', 'owner', 'issue', 'branch', 'email') ?? '',
    );
    if (!t) {
      for (const [k, v] of Object.entries(args)) {
        if (typeof v === 'string' && v && v.length < 80) { t = v; break; }
      }
    }
  }
  if (!t) return '';
  return t.replace(/\s+/g, ' ').trim();
}

function toolRenderStatus(status: string): 'active' | 'ok' | 'err' | 'blocked' {
  if (status === 'running' || status === 'queued') return 'active';
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'err';
  if (status === 'timeout') return 'blocked';
  return 'blocked';
}

/** Extract a fenced ```diff …``` block from tool result text, if present. */
const FENCES = /```diff\s*\n([\s\S]*?)```/;
function extractDiffBlock(text: string): string | null {
  if (!text) return null;
  const m = FENCES.exec(text);
  return m ? m[1] : null;
}

const EDIT_TOOLS = new Set(['edit_file', 'line_edit', 'replace_lines', 'apply_patch', 'write_file', 'delete_file']);

interface ToolProgress {
  kind: string;
  path?: string;
  percent?: number;
  bytesWritten?: number;
  bytesTotal?: number;
  lines?: number;
  linesTotal?: number;
  preview?: string;
  detail?: string;
}

interface TcShape {
  id: string;
  toolName: string;
  arguments: unknown;
  status: string;
  output?: string;
  result?: unknown;
  error?: string;
  progress?: ToolProgress;
}

/** One lightweight agent action; click to reveal arguments/output. */
function ToolRow({ tc, startTime, onFileSelect, customIcon, rail, tight }: {
  tc: TcShape;
  startTime?: number;
  onFileSelect?: (path: string) => void;
  customIcon?: string | null;
  rail?: 'first' | 'mid' | 'last' | 'only' | null;
  tight?: boolean;
}) {
  const meta = metaFor(tc.toolName);
  const Icon = meta.icon;
  const status = toolRenderStatus(tc.status);
  const [expanded, setExpanded] = useState(
    (tc.toolName === 'run_command' || tc.toolName === 'run_test' || tc.toolName === 'write_file') &&
      (tc.status === 'running' || tc.status === 'queued'),
  );
  const outputRef = useRef<HTMLPreElement>(null);
  const progressRef = useRef<HTMLPreElement>(null);
  const isMcp = !!meta.mcpServer;
  const iconColor = cn(
    status === 'active'
      ? 'text-blue-400'
      : status === 'err'
        ? 'text-red-400'
        : status === 'blocked'
          ? 'text-yellow-400'
          : meta.brandColor ?? 'text-ink-muted/85',
  );

  // Keep the tail of a streaming command visible as it grows.
  useEffect(() => {
    if ((tc.toolName === 'run_command' || tc.toolName === 'run_test') && tc.status === 'running' && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [tc.output, tc.status, tc.toolName]);

  // Keep the streaming write preview pinned to the newest chunk.
  useEffect(() => {
    if (tc.toolName === 'write_file' && tc.status === 'running' && progressRef.current) {
      progressRef.current.scrollTop = progressRef.current.scrollHeight;
    }
  }, [tc.progress?.preview, tc.status, tc.toolName]);

  const target = toolTarget(tc);
  const command = (tc.toolName === 'run_command' || tc.toolName === 'run_test' || tc.toolName === 'ssh_run' || tc.toolName === 'docker_exec')
    ? (typeof tc.arguments === 'object' && tc.arguments !== null ? (tc.arguments as Record<string, unknown>).command : undefined)
    : undefined;
  const filePath = (() => {
    if (typeof tc.arguments !== 'object' || tc.arguments === null) return undefined;
    const a = tc.arguments as Record<string, unknown>;
    for (const k of ['path', 'filePath', 'relativePath', 'file', 'target']) {
      const v = a[k];
      if (typeof v === 'string' && v) return v;
    }
    return undefined;
  })();
  const argsStr = typeof tc.arguments === 'object' && tc.arguments !== null ? JSON.stringify(tc.arguments, null, 2) : String(tc.arguments || '');
  const duration = startTime && status !== 'active' ? formatDuration(Date.now() - startTime) : null;
  const outputDiff = EDIT_TOOLS.has(tc.toolName) ? extractDiffBlock(tc.output || '') : null;

  return (
    <div
      className={cn('flex w-full', rail ? 'items-stretch' : 'items-start')}
      style={tight ? { marginTop: -6 } : undefined}
    >
      <div className="relative w-6 shrink-0 self-stretch">
        {rail && (
          <>
            {rail !== 'first' && rail !== 'only' && (
              <span className="absolute left-[11px] top-0 h-[10px] w-px bg-amber-300/30" />
            )}
            {rail !== 'last' && rail !== 'only' && (
              <span className="absolute left-[11px] top-[10px] bottom-0 w-px bg-gradient-to-b from-amber-300/30 to-amber-300/[0.05]" />
            )}
            <span className="absolute left-[8px] top-[8px] h-1.5 w-1.5 rounded-full bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.5)] ring-[2px] ring-black/60" />
          </>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className={cn(
          'group flex w-full items-center gap-1.5 rounded-md px-1.5 py-[5px] pr-2 text-left transition-colors',
          status === 'active' && 'bg-white/[0.02]',
          status === 'err' ? 'hover:bg-red-500/[0.06]' : 'hover:bg-white/[0.035]',
        )}
      >
        <span className={cn('shrink-0', iconColor)}>
          {status === 'active' ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : isMcp ? (
            /* MCP: server brand icon (custom LLM/import icon when present) + a tiny tool-type badge. */
            <span className="relative inline-flex h-[18px] w-[18px] items-center justify-center">
              {(() => {
                const resolved = resolveServerIcon(meta.mcpServer ?? '', customIcon);
                if (resolved.glyph) return <span className="text-[13px] leading-none">{resolved.glyph}</span>;
                return <resolved.Icon className={cn('h-3.5 w-3.5', resolved.color)} />;
              })()}
              <span
                className={cn(
                  'absolute -bottom-0.5 -right-0.5 flex h-3 w-3 items-center justify-center rounded-[3px] bg-surface-900 ring-1 ring-white/10',
                  FAMILY_TINTS[meta.family],
                )}
              >
                <Icon className="h-2 w-2" />
              </span>
            </span>
          ) : (
            <Icon className="h-3 w-3" />
          )}
        </span>

        {isMcp && meta.mcpServer ? (
          <span className="flex min-w-0 shrink-0 items-baseline gap-1 text-[11px] font-medium">
            <span className={cn('max-w-24 truncate', meta.brandColor ?? 'text-foreground/70')}>{meta.mcpServer}</span>
            <span className="truncate font-mono text-[10px] text-ink-muted/70">· {meta.toolShort}</span>
          </span>
        ) : (
          <span className="shrink-0 text-[11px] font-medium text-foreground/70">{meta.label}</span>
        )}

        {target && (
          <span
            className={cn(
              'min-w-0 flex-1 truncate font-mono text-[11px]',
              status === 'err' ? 'text-red-400/70' : 'text-ink-muted',
            )}
            title={target}
          >
            {target}
          </span>
        )}

        {status === 'ok' && <span className="shrink-0 text-[10px] text-green-500/70">✓</span>}
        {status === 'blocked' && <span className="shrink-0 text-[10px] text-yellow-400/80">!</span>}
        {tc.status === 'timeout' && <span className="shrink-0 text-[9px] text-yellow-400/80">timed out</span>}
        {duration && <span className="shrink-0 text-[9px] text-ink-muted/70">{duration}</span>}

        <span className="shrink-0">
          {expanded ? <ChevronDown className="h-3 w-3 text-ink-muted/70" /> : <ChevronRight className="h-3 w-3 text-ink-muted/70" />}
        </span>
      </button>

      {/* Slim live-progress bar (always visible while a file tool is writing) */}
      {status === 'active' && tc.progress && typeof tc.progress.percent === 'number' && (
        <div className="mt-0.5 ml-6 flex items-center gap-2 pr-2">
          <div className="h-0.5 w-full min-w-0 flex-1 overflow-hidden rounded-full bg-surface-800">
            <div
              className="h-full rounded-full bg-blue-400/80 transition-[width] duration-200"
              style={{ width: `${Math.min(100, tc.progress.percent)}%` }}
            />
          </div>
          <span className="shrink-0 text-[9px] tabular-nums text-ink-muted/70">{tc.progress.percent}%</span>
        </div>
      )}

      {expanded && (
        <div className="mt-1 mb-1.5 ml-3.5 space-y-1.5 rounded-lg border border-border/40 bg-surface-900/40 px-2.5 py-2 text-[11px]">
          {/* Live "writing file" stream for write_file */}
          {tc.toolName === 'write_file' && tc.status === 'running' && tc.progress && (
            <div>
              <p className="mb-0.5 flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wider text-ink-muted/70">
                <Loader2 className="h-2.5 w-2.5 animate-spin text-blue-400" />
                {tc.progress.detail || 'Writing file'}
                {typeof tc.progress.percent === 'number' && (
                  <span className="text-blue-300/80">{tc.progress.percent}%</span>
                )}
              </p>
              {(typeof tc.progress.bytesTotal === 'number' || typeof tc.progress.linesTotal === 'number') && (
                <p className="mb-1 text-[10px] tabular-nums text-ink-muted/70">
                  {typeof tc.progress.bytesTotal === 'number' && tc.progress.bytesTotal > 0 && (
                    <span>
                      {fmtBytes(tc.progress.bytesWritten || 0)} / {fmtBytes(tc.progress.bytesTotal)}
                    </span>
                  )}
                  {typeof tc.progress.linesTotal === 'number' && tc.progress.linesTotal > 0 && (
                    <span className="ml-2">
                      {tc.progress.lines || 0} / {tc.progress.linesTotal} lines
                    </span>
                  )}
                </p>
              )}
              {tc.progress.preview && (
                <pre
                  ref={progressRef}
                  className="max-h-56 overflow-y-auto overflow-x-auto rounded bg-black/40 p-1.5 font-mono text-[10px] leading-relaxed text-sky-100/90 break-all whitespace-pre-wrap"
                >
                  {tc.progress.preview}
                  <span className="ml-0.5 inline-block h-2.5 w-1.5 bg-sky-300/80 align-middle animate-pulse-soft" />
                </pre>
              )}
            </div>
          )}
          {typeof command === 'string' && (
            <div>
              <p className="mb-0.5 text-[9px] font-semibold uppercase tracking-wider text-ink-muted/70">Command</p>
              <pre className="overflow-x-auto rounded bg-black/30 p-1.5 font-mono text-[11px] text-ink-secondary break-all whitespace-pre-wrap">
                $ {command}
              </pre>
            </div>
          )}
          {(argsStr && argsStr !== '{}' && typeof command !== 'string') && (
            <div>
              <p className="mb-0.5 text-[9px] font-semibold uppercase tracking-wider text-ink-muted/70">Arguments</p>
              <pre className="max-h-32 overflow-y-auto overflow-x-auto rounded bg-black/30 p-1.5 font-mono text-[11px] text-ink-secondary break-all whitespace-pre-wrap">
                {argsStr}
              </pre>
            </div>
          )}
          {tc.output && (
            <div>
              <p className="mb-0.5 text-[9px] font-semibold uppercase tracking-wider text-ink-muted/70">Output</p>
              {outputDiff ? (
                <InlineDiff diffText={outputDiff} filePath={typeof filePath === 'string' ? filePath : undefined} maxHeight={280} />
              ) : (
                <pre
                  ref={outputRef}
                  className={cn(
                    'max-h-64 overflow-y-auto overflow-x-auto rounded p-1.5 font-mono text-[11px] break-all whitespace-pre-wrap',
                    (tc.toolName === 'run_command' || tc.toolName === 'run_test')
                      ? 'text-emerald-200/95 bg-black/60'
                      : 'text-ink-secondary bg-black/30',
                  )}
                >
                  <AnsiText text={tc.output.slice(0, 20000)} />
                  {(tc.toolName === 'run_command' || tc.toolName === 'run_test') && tc.status === 'running' && (
                    <span className="ml-0.5 inline-block h-3 w-1.5 bg-emerald-300/80 align-middle animate-pulse" />
                  )}
                </pre>
              )}
            </div>
          )}
          {tc.error && (
            <div>
              <p className="mb-0.5 text-[9px] font-semibold uppercase tracking-wider text-red-400/80">Error</p>
              <pre className="overflow-x-auto rounded bg-red-500/[0.06] p-1.5 font-mono text-[11px] text-red-300/90 break-all whitespace-pre-wrap">
                {tc.error}
              </pre>
            </div>
          )}
          {typeof filePath === 'string' && onFileSelect && status !== 'active' && (
            <button
              onClick={() => onFileSelect(filePath)}
              className="flex items-center gap-1 text-[10px] text-amber-300 hover:text-amber-200 transition-colors"
            >
              <Code2 className="h-2.5 w-2.5" /> Open in editor
            </button>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

/** Small phase label that groups related actions ("● Inspecting"). */
function ActivityHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="ml-6 py-0.5 flex items-center gap-1.5">
      <span className="h-1 w-1 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.6)]" />
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-200/80">{label}</span>
      {count > 1 && <span className="text-[9px] tabular-nums text-amber-200/50">{count}</span>}
    </div>
  );
}

/** Brand avatar shown exactly once, above the agent's very first message. */
function AgentAvatar() {
  return (
    <BrandIcon
      size={34}
      className="mt-0.5 shrink-0 rounded-lg ring-1 ring-amber-400/25 shadow-[0_0_18px_-4px_rgba(251,191,36,0.4)]"
    />
  );
}

// ── Todo list ────────────────────────────────────────────────────────────

interface TodoShape { content: string; status: string; priority: string }

function TodoList({ todos }: { todos: TodoShape[] }) {
  const [expanded, setExpanded] = useState(true);
  const completed = todos.filter(t => t.status === 'completed').length;
  const inProgress = todos.filter(t => t.status === 'in_progress').length;

  return (
    <div className="agent-card agent-card--todo">
      <button onClick={() => setExpanded(!expanded)} className="agent-card__header">
        <ListChecks className="agent-card__icon text-ink-muted/70" />
        <span className="agent-card__title">Task list</span>
        <span className="agent-card__count">
          {completed}/{todos.length} done{inProgress > 0 && ` · ${inProgress} active`}
        </span>
        {expanded ? <ChevronDown className="agent-card__chevron ml-auto" /> : <ChevronRight className="agent-card__chevron ml-auto" />}
      </button>
      {expanded && (
        <div className="agent-card__body mb-1">
          {todos.map((t, i) => {
            const done = t.status === 'completed';
            const active = t.status === 'in_progress';
            const cancelled = t.status === 'cancelled';
            return (
              <div key={i} className={cn('todo-row', cancelled && 'todo-row--cancelled')}>
                <span className={cn('todo-row__check', done && 'todo-row__check--done', active && 'todo-row__check--active')}>
                  {done ? <Check className="h-2.5 w-2.5" /> : active ? <Loader2 className="animate-spin" /> : null}
                </span>
                <span className={cn('todo-row__text', done && 'todo-row__text--done', cancelled && 'todo-row__text--cancelled')}>
                  {t.content}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Side-rail task timeline — each task is a node on a vertical rail with a
 *  live progress bar, so the agent's plan reads as one graphical story. */
function TodoTimeline({ todos }: { todos: TodoShape[] }) {
  const total = todos.length;
  const completed = todos.filter(t => t.status === 'completed').length;
  const cancelled = todos.filter(t => t.status === 'cancelled').length;
  const inProgress = todos.filter(t => t.status === 'in_progress').length;
  const settled = completed + cancelled;
  const pct = total > 0 ? Math.round((settled / total) * 100) : 0;

  return (
    <div className="agent-card agent-card--todo agent-card--timeline">
      <div className="agent-card__header">
        <ListChecks className="agent-card__icon text-emerald-300/80" />
        <span className="agent-card__title">Task timeline</span>
        {total === 0 ? (
          <span className="agent-card__count ml-auto">
            {inProgress > 0 && ` · ${inProgress} active`}
          </span>
        ) : (
          <span className="agent-card__count ml-auto">
            {completed}/{total} done{inProgress > 0 && ` · ${inProgress} active`}
          </span>
        )}
      </div>
      {total === 0 ? (
        <div className="agent-card__body space-y-1">
          <span className="block text-[10px] text-ink-muted/60">
            The agent plans its work here as it runs — no tasks announced yet.
          </span>
        </div>
      ) : (
        <>
      {/* Live progress meter */}
      <div className="mb-2 mt-0.5 flex items-center gap-2 pl-2">
        <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-800/80">
          <div
            className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-teal-400 to-accent transition-[width] duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="shrink-0 text-[9px] font-medium tabular-nums text-emerald-300/80">{pct}%</span>
      </div>

      {/* Vertical timeline */}
      <div className="px-0.5">
        {todos.map((t, i) => {
          const isDone = t.status === 'completed';
          const isActive = t.status === 'in_progress';
          const isCancelled = t.status === 'cancelled';
          const isLast = i === total - 1;
          return (
            <div key={i} className="relative flex gap-2 pb-2.5 last:pb-0">
              {/* rail connector (skip under the last node) */}
              {!isLast && (
                <span
                  className={cn(
                    'absolute left-[7px] top-[18px] bottom-[2px] w-px',
                    isDone ? 'bg-gradient-to-b from-emerald-400/40 to-surface-700' : 'bg-surface-700',
                  )}
                />
              )}
              {/* status node */}
              <span
                className={cn(
                  'relative z-10 mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition-colors',
                  isDone
                    ? 'border-emerald-400/60 bg-emerald-400/15 text-emerald-300 shadow-[0_0_6px_rgba(52,211,153,0.35)]'
                    : isActive
                      ? 'border-blue-400/70 bg-blue-400/15 text-blue-300'
                      : isCancelled
                        ? 'border-zinc-500/50 bg-zinc-500/10 text-zinc-400'
                        : 'border-zinc-600 bg-surface-900 text-transparent',
                )}
              >
                {isDone ? (
                  <Check className="h-2 w-2" strokeWidth={3} />
                ) : isActive ? (
                  <Loader2 className="h-2 w-2 animate-spin" />
                ) : isCancelled ? (
                  <X className="h-2 w-2" strokeWidth={2.5} />
                ) : null}
                {isActive && (
                  <span className="absolute inset-0 -m-[2px] rounded-full border border-blue-400/30 animate-pulse" />
                )}
              </span>
              {/* task copy — wraps to new lines, never truncates */}
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    'break-words text-[11px] leading-snug text-ink-secondary',
                    (isDone || isCancelled) && 'text-ink-muted/70 line-through',
                    isActive && 'font-medium text-foreground/90',
                  )}
                >
                  {t.content}
                </p>
                {isActive && (
                  <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-blue-400/10 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-blue-300">
                    <span className="h-1 w-1 rounded-full bg-blue-400 animate-pulse" />
                    In progress
                  </span>
                )}
                {t.priority === 'high' && (
                  <span className="mt-1 ml-1 inline-flex rounded-full bg-amber-400/10 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-300">
                    High
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
        </>
      )}
    </div>
  );
}

// ── Live sub-context panel — streams opens/closes in real time ───────────

interface CtxEvent { kind: 'open' | 'close'; id: string; ts: number }

function ContextBar({ active, maxActive, servers, variant = 'inline' }: {
  active: Array<{ id: string; title: string }>;
  maxActive?: number;
  servers?: Array<{ id: string; name: string; description?: string; icon: string | null }>;
  variant?: 'inline' | 'side';
}) {
  const [expanded, setExpanded] = useState(true);
  const [events, setEvents] = useState<CtxEvent[]>([]);
  const prevIds = useRef<Set<string>>(new Set());

  // Readable labels: sub-contexts carry a title from the backend; MCP servers
  // are keyed as mcp_<id> — map them to their configured name so the UI never
  // shows an opaque uuid.
  const labelFor = useCallback((id: string): string => {
    if (id.startsWith('mcp_')) {
      const server = servers?.find((s) => `mcp_${s.id}` === id);
      if (server?.name) return server.name;
      const base = id.replace(/^mcp_/, '');
      const title = active.find((a) => a.id === id)?.title;
      if (title && title !== id) return title;
      return base.slice(0, 24);
    }
    return active.find((a) => a.id === id)?.title || id;
  }, [active, servers]);

  const chipIcon = (id: string): React.ReactNode => {
    if (id.startsWith('mcp_')) {
      const server = servers?.find((s) => `mcp_${s.id}` === id);
      if (server) {
        const { Icon, color, glyph } = resolveServerIcon(server.name, server.icon);
        return glyph ? (
          <span className="context-chip__glyph">{glyph}</span>
        ) : (
          <Icon className={cn('context-chip__icon', color)} />
        );
      }
    }
    return <Layers className="context-chip__icon text-violet-300/60" />;
  };

  useEffect(() => {
    const next = new Set(active.map((a) => a.id));
    const opened = active.filter((a) => !prevIds.current.has(a.id));
    const closed = [...prevIds.current].filter((id) => !next.has(id));
    prevIds.current = next;

    if (opened.length === 0 && closed.length === 0) return;

    const batch: CtxEvent[] = [
      ...opened.map((a) => ({ kind: 'open' as const, id: a.id, ts: Date.now() })),
      ...closed.map((id) => ({ kind: 'close' as const, id, ts: Date.now() })),
    ];
    setEvents((prev) => [...prev, ...batch].slice(-6));
  }, [active]);

  useEffect(() => {
    if (events.length === 0) return;
    const t = setTimeout(() => setEvents((prev) => prev.filter((e) => Date.now() - e.ts < 4000)), 4000);
    return () => clearTimeout(t);
  }, [events]);

  if (active.length === 0 && events.length === 0) return null;

  const cap = maxActive ?? 10;

  // Side-rail variant: one row per active context with a brand icon tile and
  // the label wrapped on its own line — a proper mini-panel instead of chips.
  if (variant === 'side') {
    return (
      <div className="agent-card agent-card--context">
        <div className="agent-card__header">
          <Layers className="agent-card__icon text-violet-300/70" />
          <span className="agent-card__title">Context</span>
          <span className="agent-card__count ml-auto">
            {active.length}/{cap} open
          </span>
        </div>
        <div className="agent-card__body space-y-1.5">
          {active.length === 0 ? (
            <span className="text-[10px] text-ink-muted/70">no contexts open</span>
          ) : (
            active.map((a) => {
              const isMcp = a.id.startsWith('mcp_');
              const server = isMcp ? servers?.find((s) => `mcp_${s.id}` === a.id) : undefined;
              return (
                <div key={a.id} className="flex items-center gap-2" title={a.id}>
                  <span
                    className={cn(
                      'flex h-6 w-6 shrink-0 items-center justify-center rounded-md ring-1',
                      isMcp
                        ? 'bg-surface-800 ring-white/[0.06]'
                        : 'bg-violet-400/10 ring-violet-400/20',
                    )}
                  >
                    {isMcp && server ? (
                      (() => {
                        const { Icon, color, glyph } = resolveServerIcon(server.name, server.icon);
                        return glyph ? (
                          <span className="text-sm leading-none">{glyph}</span>
                        ) : (
                          <Icon className={cn('h-3.5 w-3.5', color)} />
                        );
                      })()
                    ) : (
                      <Layers className="h-3.5 w-3.5 text-violet-300/70" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="block break-words text-[11px] font-medium leading-snug text-foreground/85">
                      {labelFor(a.id)}
                    </span>
                    {isMcp && server?.description && (
                      <span className="block truncate text-[9px] text-ink-muted/60">{server.description}</span>
                    )}
                  </div>
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400 shadow-[0_0_6px_rgba(167,139,250,0.5)]" />
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="agent-card agent-card--context">
      <button onClick={() => setExpanded(!expanded)} className="agent-card__header">
        <Layers className="agent-card__icon text-violet-300/70" />
        <span className="agent-card__title">Context</span>
        <span className="agent-card__count">
          {active.length}/{cap} open
        </span>
        <span className="ml-auto flex flex-wrap items-center justify-end gap-1">
          {events.map((e, i) => (
            <span key={`${e.id}-${e.ts}`} className={cn('status-event', e.kind === 'open' ? 'status-event--open' : 'status-event--close')}>
              {e.kind === 'open' ? '+' : '−'}{labelFor(e.id)}
            </span>
          ))}
        </span>
        {expanded ? <ChevronDown className="agent-card__chevron" /> : <ChevronRight className="agent-card__chevron" />}
      </button>
      {expanded && (
        <div className="agent-card__body flex flex-wrap gap-1">
          {active.length === 0 ? (
            <span className="text-[10px] text-ink-muted/70">no contexts open</span>
          ) : (
            active.map((a) => (
              <span key={a.id} className="context-chip" title={a.id}>
                {chipIcon(a.id)}
                {labelFor(a.id)}
              </span>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── Thinking + agent state indicators ────────────────────────────────────

// ── Thought phase (model reasoning) ──────────────────────────────────────
// Foldable section for the model's internal reasoning ("Thought phase").
// Streamed live during generation (streaming = auto-open), persisted on the
// message reload path renders collapsed so it never competes with the answer.

function ThoughtSection({ text, streaming, rail }: { text: string; streaming?: boolean; rail?: boolean }) {
  const [open, setOpen] = useState(streaming ?? false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    if (streaming && text) setOpen(true);
  }, [streaming, text]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !streaming) return;
    if (!stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [text, streaming]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  if (!text?.trim()) return null;

  const body = (
    <div className="mb-1.5 max-w-[75%]">
      <button
        onClick={() => setOpen(!open)}
        className={cn('mb-0.5 flex w-full items-center gap-1.5 px-0.5 text-left', streaming && 'animate-pulse-soft')}
      >
        <span className="h-1 w-1 rounded-full bg-amber-300/70" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted/70">Planning</span>
        {streaming && <span className="ml-0.5 inline-block h-1 w-1 rounded-full bg-amber-300/80 animate-pulse-soft" />}
        <span className="ml-auto text-[9px] tabular-nums text-ink-muted/60">{open ? 'hide' : `${text.length} chars`}</span>
      </button>
      {open && (
        <div className="overflow-hidden rounded-md border border-amber-300/[0.14] bg-amber-300/[0.05]">
          <div
            ref={bodyRef}
            onScroll={onScroll}
            className="max-h-44 overflow-y-auto px-2.5 py-2 text-[11px] leading-relaxed text-amber-100/80"
          >
            <MarkdownRenderer content={text} />
            {streaming && (
              <span className="ml-0.5 inline-block h-2.5 w-0.5 bg-amber-100/50 animate-pulse-soft" />
            )}
          </div>
        </div>
      )}
    </div>
  );

  if (!rail) return body;
  return (
    <div className="relative">
      <span className="absolute left-[11px] top-0 bottom-0 w-px bg-amber-300/25" />
      <div className="ml-6">{body}</div>
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 py-0.5 text-xs text-ink-muted/85">
      <div className="flex gap-1">
        <span className="h-1.5 w-1.5 rounded-full bg-blue-400/80 animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="h-1.5 w-1.5 rounded-full bg-blue-400/80 animate-bounce" style={{ animationDelay: '150ms' }} />
        <span className="h-1.5 w-1.5 rounded-full bg-blue-400/80 animate-bounce" style={{ animationDelay: '300ms' }} />
      </div>
      <span>Thinking…</span>
    </div>
  );
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}

/** Live banner shown while the agent summarizes & prunes older context. */
function CompactingBanner({ tokensBefore }: { tokensBefore?: number }) {
  return (
    <div className="mx-2 my-2 rounded-lg border border-violet-500/20 bg-violet-500/5 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-violet-400" />
        <span className="text-xs font-medium text-violet-300">Compacting context…</span>
      </div>
      <p className="mt-1 text-[11px] text-violet-300/60">
        Summarizing older messages to free up context space{tokensBefore ? ` (~${formatTokenCount(tokensBefore)} tokens)` : ''}. The agent will continue automatically.
      </p>
    </div>
  );
}

/** Notice rendered after a compaction completes — shows savings + collapsible summary. */
function CompactedNotice({ tokensBefore, tokensAfter, tokensSaved, summary }: {
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  summary?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const pct = tokensBefore > 0 ? Math.round((tokensSaved / tokensBefore) * 100) : 0;

  return (
    <div className="mx-2 my-2 rounded-lg border border-violet-500/15 bg-violet-500/5 px-3 py-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <History className="h-3.5 w-3.5 shrink-0 text-violet-400/70" />
        <span className="flex-1 text-xs text-ink-muted">
          Context compacted · {formatTokenCount(tokensSaved)} tokens saved ({pct}%) ·{' '}
          <span className="text-ink-muted/60">{formatTokenCount(tokensBefore)} → {formatTokenCount(tokensAfter)}</span>
        </span>
        <ChevronRight className={cn('h-3 w-3 shrink-0 text-ink-muted/50 transition-transform', expanded && 'rotate-90')} />
      </button>
      {expanded && summary && (
        <div className="mt-2 max-h-48 overflow-y-auto rounded-md bg-surface-800/50 px-3 py-2 text-[11px] leading-relaxed text-ink-muted/80 scrollbar-thin">
          <p className="mb-1 font-medium text-ink-muted/60">Summary of compacted context:</p>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

interface FreeModelSuggestionProps {
  /** Raw error text that triggered the exhaustion detection. */
  error: string;
  /** Currently selected provider. */
  currentProvider: string;
  /** Switch the agent to the given free model + provider. */
  onSwitchToFree: (provider: string, model: string) => void;
  onDismiss: () => void;
}

/** Post-failure suggestion card shown when the free tier runs out of tokens —
 *  offers one-click switches to free OmniRoute models and "auto" routing. */
function FreeModelSuggestionCard({ error, currentProvider, onSwitchToFree, onDismiss }: FreeModelSuggestionProps) {
  const alreadyFree = FREE_PROVIDERS.has(currentProvider);
  return (
    <div className="mx-2 my-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2.5">
      <div className="flex items-start gap-2">
        <Zap className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-amber-200">
            {alreadyFree ? 'Free model out of tokens' : 'Free tokens exhausted on this provider'}
          </p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-amber-100/70">
            {alreadyFree
              ? 'The current free model hit its limit. Try a free "auto" router or a different free model below.'
              : 'This run used up its free credits/tokens. Switch to a free OmniRoute model to keep working with no key needed.'}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {FREE_MODEL_SUGGESTIONS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onSwitchToFree('omniroute', m)}
                className="inline-flex items-center gap-1 rounded-full bg-amber-400/15 px-2.5 py-1 text-[11px] font-medium text-amber-100 transition-colors hover:bg-amber-400/25"
              >
                <Sparkles className="h-3 w-3" />
                {m}
              </button>
            ))}
            {!alreadyFree && (
              <button
                type="button"
                onClick={() => onSwitchToFree('omniroute', 'big-pickle')}
                className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2.5 py-1 text-[11px] font-medium text-[#c4b5fd] transition-colors hover:bg-primary/25"
              >
                <Zap className="h-3 w-3" />
                Enable free OmniRoute
              </button>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 text-ink-muted/50 transition-colors hover:text-ink-muted"
          title="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <details className="mt-1.5">
        <summary className="cursor-pointer text-[10px] text-amber-100/50">Error details</summary>
        <p className="mt-1 break-words text-[10px] leading-relaxed text-amber-100/50">{error.slice(0, 300)}</p>
      </details>
    </div>
  );
}

/** Compact progress bar showing context usage vs compaction threshold. */
function ContextUsageBar({ used, limit, compactionAt, state, compact }: {
  used: number;
  limit: number;
  compactionAt: number;
  state: 0 | 1 | 2 | 3;
  compact?: boolean;
}) {
  const pct = Math.min(100, (used / limit) * 100);
  const compactionPct = Math.min(100, (compactionAt / limit) * 100);

  const barColor =
    state === 3 ? 'bg-red-500'
    : state === 2 ? 'bg-orange-500'
    : state === 1 ? 'bg-yellow-500'
    : 'bg-emerald-500';

  const nearCompaction = used >= compactionAt * 0.85 && used < compactionAt;
  const label =
    state === 3 ? 'Full — compaction imminent'
    : state === 2 ? 'Compaction threshold reached'
    : nearCompaction ? 'Approaching compaction'
    : null;

  return (
    <div className="flex shrink-0 items-center gap-2">
      <div className={cn('relative h-1.5 overflow-hidden rounded-full bg-surface-700', compact ? 'w-10' : 'w-16')}>
        {/* Compaction threshold marker */}
        <div
          className="absolute top-0 bottom-0 w-px bg-orange-400/60"
          style={{ left: `${compactionPct}%` }}
          title={`Compaction at ${formatTokenCount(compactionAt)} tokens (70%)`}
        />
        {/* Fill bar */}
        <div
          className={cn('absolute inset-y-0 left-0 rounded-full transition-all duration-300', barColor)}
          style={{ width: `${pct}%` }}
        />
      </div>
      {label && !compact && (
        <span className="hidden text-[9px] text-ink-muted/60 shrink-0 md:inline">{label}</span>
      )}
    </div>
  );
}

// ── Status line ──────────────────────────────────────────────────────────

/** Coerce whatever the model sent as ask_user options into {label, description}
 *  objects so the option cards always render. Accepts objects, raw strings,
 *  or an empty/missing value. */
function normalizeAskUserOptions(raw: unknown): Array<{ label: string; description: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ label: string; description: string }> = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.trim()) out.push({ label: item.trim(), description: '' });
    } else if (item && typeof item === 'object') {
      const label = String((item as any).label ?? (item as any).name ?? '').trim();
      if (label) {
        out.push({
          label,
          description: String((item as any).description ?? (item as any).desc ?? '') || '',
        });
      }
    }
  }
  return out;
}

function AgentStatusIndicator({ stepCount, duration, isRunning, streamingText, messages, simple }: {
  stepCount: number;
  duration: number;
  isRunning: boolean;
  streamingText?: string;
  messages: AgentMessage[];
  simple?: boolean;
}) {
  if (!isRunning) return null;

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const toolCalls = lastAssistant?.toolCalls || [];
  const runningTools = toolCalls.filter((tc) => tc.status === 'running' || tc.status === 'queued');
  const completedTools = toolCalls.filter((tc) => tc.status === 'completed');
  const currentTool = runningTools[0];

  let statusText = 'Thinking…';
  if (streamingText) {
    statusText = 'Generating response…';
  } else if (currentTool) {
    const meta = metaFor(currentTool.toolName);
    const cmd = toolTarget(currentTool);
    statusText = cmd ? `${meta.label}: ${cmd}` : `${meta.label}…`;
  } else if (stepCount > 0) {
    statusText = `Step ${stepCount} — thinking…`;
  }

  if (simple) {
    // Quiet single line — no tool names, no step machinery.
    return (
      <div className="flex items-center gap-2 border-b border-border/30 px-4 py-1.5 text-[11px] text-ink-muted/80">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400 animate-pulse-soft" />
        <span className="min-w-0 flex-1 truncate">
          {streamingText ? 'Writing the answer…' : 'Working on your request…'}
        </span>
        <span className="shrink-0 tabular-nums">{formatDuration(duration)}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 border-b border-border/30 px-4 py-1.5 text-[11px] text-ink-muted/80">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400 animate-pulse-soft" />
      <span className="min-w-0 flex-1 truncate">{statusText}</span>
      <span className="shrink-0 tabular-nums">{formatDuration(duration)}</span>
      {completedTools.length > 0 && (
        <span className="shrink-0 text-green-500/70">{completedTools.length} done</span>
      )}
    </div>
  );
}

// ── Main AgentChat ───────────────────────────────────────────────────────

export function AgentChat({ sessionId, workspacePath, isRunning, onStatusChange, onFileSelect, model, provider, onModelChange, injectedPrompt, sessions = [], activeSessionId, onSelectSession, onNewSession, remoteProfileId, mode }: Props) {
  const workspaceMode = useWorkspace().state.uiMode;
  const simple = (mode ?? workspaceMode) === 'simple';
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [streamingThought, setStreamingThought] = useState('');
  const [stepCount, setStepCount] = useState(0);
  const [duration, setDuration] = useState(0);
  const [activeContexts, setActiveContexts] = useState<Array<{ id: string; title: string }>>([]);
  const [todos, setTodos] = useState<TodoItem[] | null>(null);
  const [pendingPermission, setPendingPermission] = useState<{ toolCallId: string; toolName: string; args: unknown } | null>(null);
  const [pendingAskUser, setPendingAskUser] = useState<{ toolCallId: string; question: string; options: Array<{ label: string; description: string }>; multiple: boolean } | null>(null);
  // MCP stock widget — fed by the inspect_mcp_stock tool's `mcp.stock` event.
  const [mcpStock, setMcpStock] = useState<McpStockPayload | null>(null);
  // Inline stock card dismissed by the user (resets on the next mcp.stock event).
  const [mcpStockDismissed, setMcpStockDismissed] = useState(false);
  const [mcpInlineEnableBusy, setMcpInlineEnableBusy] = useState<string | null>(null);
  // Inline OAuth connect for a server row in the MCP bar (id → connecting state).
  const [mcpOauthConnecting, setMcpOauthConnecting] = useState<string | null>(null);
  const [stockAction, setStockAction] = useState<{ id: string; status: 'adding' | 'done' | 'error'; message?: string } | null>(null);
  // MCP enable popup — auto-opens when the stock payload flags disabled servers.
  const [mcpEnableOpen, setMcpEnableOpen] = useState(false);
  const [mcpAddOpen, setMcpAddOpen] = useState(false);
  // Full stock catalog flattened for the manual "Add MCP server" flow (populated
  // from /api/mcp/stock when the user asks to add more from the suggestion card).
  const [mcpCatalog, setMcpCatalog] = useState<McpStockEntry[] | null>(null);
  const [tokenPromptRow, setTokenPromptRow] = useState<McpStockEntryInline | null>(null);
  // Paused MCP approval decision (run is waiting_mcp_approval) — mirrored from
  // the store so the popup re-asks after navigation / refresh.
  const [pendingMcpDecision, setPendingMcpDecision] = useState<{
    toolCallId: string;
    task: string | null;
    servers: unknown[];
    recommendedToEnableIds: string[];
    recommendedToAddIds: string[];
  } | null>(null);
  const [isUserScrolled, setIsUserScrolled] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [lastCompaction, setLastCompaction] = useState<{ tokensBefore: number; tokensAfter: number; tokensSaved: number; messagesCompacted: number; summary?: string } | null>(null);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingOlderRef = useRef(false);
  const [indexStats, setIndexStats] = useState<{ files: number; symbols: number; ready: boolean; error?: string } | null>(null);
  const [ideAvailable, setIdeAvailable] = useState(false);
  const [freeSuggestion, setFreeSuggestion] = useState<string | null>(null);
  const [composerWidth, setComposerWidth] = useState(0);
  const [chatWidth, setChatWidth] = useState(0);
  const [railDismissed, setRailDismissed] = useState(false);
  const [showSteps, setShowSteps] = useState(false);
  const chatRootRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const durationInterval = useRef<NodeJS.Timeout | null>(null);
  const agentStartTimeRef = useRef<number>(0);
  const toolStartTimes = useRef<Map<string, number>>(new Map());
  const handleEventRef = useRef<(event: AgentEvent) => void>(() => {});

  // ── Model picker + key indicator ───────────────────────────────────────
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [savedKeys, setSavedKeys] = useState<UserKeyDto[]>([]);
  const [omniModels, setOmniModels] = useState<string[]>([]);
  const [omniHealth, setOmniHealth] = useState<
    Record<string, { available: boolean; latencyMs: number | null; keyRequired: boolean; isFree: boolean }>
  >({});

  useEffect(() => {
    agentApi.getModels().then((data: any) => {
      if (data?.providers) setProviders(data.providers);
    }).catch(() => {});
    api.fetchOmniRouteRanked().then((res) => {
      const ranked = res?.ranked || [];
      setOmniHealth(
        Object.fromEntries(
          ranked.map((m) => [
            m.id,
            {
              available: !!m.isAvailable,
              latencyMs: m.latencyMs ?? null,
              keyRequired: !!m.keyRequired,
              isFree: !!m.isFree,
            },
          ]),
        ),
      );
      setOmniModels(ranked.map((m) => m.id));
    }).catch(() => {
      api.fetchOmniRouteModels().then((res) => {
        const models = res?.models || [];
        setOmniHealth(
          Object.fromEntries(
            models.map((m) => [
              m.id,
              {
                available: !!m.isAvailable,
                latencyMs: m.latencyMs ?? null,
                keyRequired: !!m.keyRequired,
                isFree: !!m.isFree,
              },
            ]),
          ),
        );
        setOmniModels(models.map((m) => m.id));
      }).catch(() => {});
    });
    api.listKeys().then((data) => {
      if (data?.keys) setSavedKeys(data.keys);
    }).catch(() => {});
  }, []);

  // Merge the live OmniRoute model list into the omniroute provider so the
  // agent chat picker shows every real model, not just the curated subset.
  const displayProviders = useMemo(() => {
    if (omniModels.length === 0) return providers;
    return providers.map((p) =>
      p.id === 'omniroute' ? { ...p, models: Array.from(new Set([...p.models, ...omniModels])) } : p,
    );
  }, [providers, omniModels]);

  const hasKeyForCurrentProvider = useMemo(() => {
    if (!provider) return true;
    return savedKeys.some((k) => k.provider === provider && k.status === 'ok');
  }, [provider, savedKeys]);

  const needsKey = KEY_REQUIRED_PROVIDERS.has(provider || '') && !hasKeyForCurrentProvider;

  // ── Token budget estimation ─────────────────────────────────────────────
  const inputTokens = useMemo(() => estimateTokens(input), [input]);
  const tokenBudget = useMemo(() => {
    const caps = getModelCapabilities(provider || 'omniroute', model || 'big-pickle');
    const limit = Math.max(1, caps.contextWindow - caps.maxOutputTokens - 2000);
    const historyTokens = estimateHistoryTokens(
      messages.map((m) => ({ role: m.role, content: m.content })),
    );
    const used = inputTokens + historyTokens + 2000;
    const compactionAt = Math.floor(limit * COMPACTION_THRESHOLD);
    let state: 0 | 1 | 2 | 3 = 0;
    if (used >= limit) state = 3;
    else if (used >= compactionAt) state = 2;
    else if (used >= compactionAt * 0.85) state = 1;
    return { used, limit, compactionAt, state };
  }, [inputTokens, messages, model, provider]);

  const tokenStateClass =
    tokenBudget.state === 3 ? 'text-red-400'
    : tokenBudget.state === 2 ? 'text-orange-400'
    : tokenBudget.state === 1 ? 'text-yellow-400/80'
    : 'text-ink-muted';

  useEffect(() => {
    // Reset transient per-session state the moment the session changes so the
    // previous conversation never flashes / lingers while the new one loads.
    // Live run state (streaming text, todos, contexts, …) is mirrored from the
    // module-level session store in a later effect, so we do NOT abort any
    // stream here — an in-flight run of the previous session keeps streaming.
    setMessages([]);
    setStreamingText('');
    setStreamingThought('');
    setIsThinking(false);
    setIsCompacting(false);
    setLastCompaction(null);
    setHasMoreOlder(false);
    setStepCount(0);
    loadMessages();
    hydrateSessionState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Request desktop notification permission so we can alert the user when
  // the agent needs input while the app is in the background.
  useEffect(() => {
    requestNotificationPermission();
  }, []);

  // Gate the "Open in IDE" button on whether a VS Code-family editor is
  // installed, so it only appears when launching will actually succeed.
  useEffect(() => {
    checkIdeAvailable().then(setIdeAvailable);
  }, []);

  // Collapse the composer textarea to its default single-line height whenever
  // the input is cleared (after send / interrupt) so it doesn't stay stretched.
  useEffect(() => {
    if (!input && inputRef.current) {
      inputRef.current.style.height = 'auto';
    }
  }, [input]);

  // Show the SQLite workspace-index status so the user can see the agent is
  // backed by a project index (not just grep). Refreshed whenever the active
  // workspace changes.
  useEffect(() => {
    if (!workspacePath) {
      setIndexStats(null);
      return;
    }
    let cancelled = false;
    agentApi.getWorkspaceIndex(workspacePath)
      .then((s) => { if (!cancelled) setIndexStats(s); })
      .catch(() => { if (!cancelled) setIndexStats(null); });
    return () => { cancelled = true; };
  }, [workspacePath]);

  // Live MCP server list — shared store, refreshed on every mutation.
  const { servers: mcpServers, refresh: refreshMcpList } = useMcpList();
  const mcpIconByServer = useMemo(
    () => new Map(mcpServers.map((s) => [s.name.trim().toLowerCase(), s.icon ?? null])),
    [mcpServers],
  );

  useEffect(() => {
    if (injectedPrompt?.text) {
      setInput(injectedPrompt.text);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [injectedPrompt?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // NOTE: there is deliberately NO abort-on-unmount. The stream/run loop lives
  // in the module-level session store, so navigating away or switching sessions
  // keeps the agent running until the user explicitly stops it. This panel only
  // re-attaches on mount via store subscription + event replay.

  useEffect(() => {
    if (!isUserScrolled) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streamingText, isUserScrolled, pendingPermission]);

  useEffect(() => {
    if (isRunning && agentStartTimeRef.current > 0) {
      durationInterval.current = setInterval(() => {
        setDuration(Math.floor((Date.now() - agentStartTimeRef.current) / 1000));
        // Watchdog: a tool that started but never received tool.completed /
        // tool.failed (dropped SSE, abandoned run) would spin as "running"
        // forever. Mark any such tool timed-out after a hard cap so the UI
        // never shows an infinite spinner.
        const now = Date.now();
        setMessages((prev) => {
          let dirty = false;
          const next = prev.map((m) => {
            if (m.role !== 'assistant' || !m.toolCalls?.length) return m;
            const updated = m.toolCalls.map((tc) => {
              if (tc.status !== 'running') return tc;
              const start = toolStartTimes.current.get(tc.id);
              if (!start || now - start < TOOL_WATCHDOG_MS) return tc;
              dirty = true;
              return { ...tc, status: 'timeout', output: tc.output || 'Timed out — no completion received.', error: 'Timed out' };
            });
            return updated === m.toolCalls ? m : { ...m, toolCalls: updated };
          });
          return dirty ? next : prev;
        });
      }, 1000);
    }
    return () => {
      if (durationInterval.current) clearInterval(durationInterval.current);
    };
  }, [isRunning]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setIsUserScrolled(!atBottom);
    // Scroll-up pagination: when the user reaches the top and older messages
    // exist, fetch the next earlier page and prepend it, preserving position.
    if (el.scrollTop < 40 && hasMoreOlder && !loadingOlderRef.current) {
      loadOlderMessages();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMoreOlder, loadingOlder, messages]);

  async function loadMessages() {
    try {
      const msgs = await agentApi.getMessages(sessionId);
      setMessages(msgs);
      // The initial load fetches up to 200 messages (the backend's window).
      // Only offer "load earlier" when that window could be truncated; showing
      // it for every session produced a useless button that loaded an empty page.
      setHasMoreOlder(msgs.length >= 200);
    } catch { /* ignore */ }
  }

  // Restore the session's persisted run state (active sub-contexts) so the
  // live context bar survives a refresh/session switch. The BE persists the
  // active set with titles in the session's contextSnapshot and only EVER
  // changes it via the LLM's context_manage calls — the UI just mirrors it.
  async function hydrateSessionState() {
    try {
      const session = await agentApi.getSession(sessionId);
      const snapshot = session?.contextSnapshot;
      const ctx = Array.isArray(snapshot?.activeContexts)
        ? snapshot!.activeContexts as Array<{ id: string; title: string }>
        : Array.isArray(snapshot?.activeSubContexts)
          ? (snapshot!.activeSubContexts as string[]).map((id) => ({ id, title: id }))
          : [];
      setActiveContexts(ctx);
    } catch { /* ignore */ }
  }

  // Preserve scroll position across a prepend so loading earlier messages
  // doesn't yank the user's viewport. Measure the container's scroll height
  // before prepending, then add the delta afterwards.
  async function loadOlderMessages() {
    const el = scrollContainerRef.current;
    if (!el || loadingOlderRef.current || !messages.length) return;
    const first = messages[0];
    if (!first?.id || !first?.createdAt) return;
    // Synchronous reentrancy lock: the button click and the scroll-up handler
    // can both fire around the same render, and React state is async — a plain
    // state flag would let two in-flight fetches prepend the same page twice.
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const beforeScrollHeight = el.scrollHeight;
    try {
      const page = await agentApi.getOlderMessages(sessionId, first.createdAt, first.id);
      const older = page.messages;
      setHasMoreOlder(page.hasMore && older.length > 0);
      setMessages((prev) => {
        // Merge by id so a re-entrant/overlapping page never renders twice.
        const seen = new Set(prev.map((m) => m.id));
        const fresh = older.filter((m) => !seen.has(m.id));
        if (fresh.length === 0) return prev;
        return [...fresh, ...prev];
      });
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - beforeScrollHeight;
      });
    } catch { /* ignore */ }
    finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }

const handleEvent = useCallback((event: AgentEvent) => {
    const { type, data } = event;

    switch (type) {
      case 'text.end': {
        const toolCalls = Array.isArray(data.toolCalls) && data.toolCalls.length > 0
          ? data.toolCalls.map((tc: any) => ({
              id: tc.id || `tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              toolName: tc.toolName || tc.name || 'unknown',
              arguments: tc.arguments || tc.args || {},
              status: 'running' as string,
              output: undefined,
              result: undefined,
              error: undefined,
            }))
          : undefined;
        const reasoning = (data.reasoning as string) || streamingThought || undefined;
        const msgId = data.messageId as string | undefined;
        const content = (data.content as string) || '';

        if (content || toolCalls) {
          setMessages((prev) => {
            const next = [...prev];
            // Replay safety: the live event may already have built this message
            // (a re-attached panel replays the run's buffered events) — merge
            // by id / tool-call id instead of duplicating.
            let existingIdx = msgId ? next.findIndex((m) => m.id === msgId) : -1;
            if (existingIdx === -1 && toolCalls && toolCalls.length > 0) {
              const tcIds = new Set(toolCalls.map((tc) => tc.id));
              existingIdx = next.findIndex((m) =>
                m.role === 'assistant' && m.toolCalls?.some((tc) => tcIds.has(tc.id)),
              );
            }
            if (existingIdx !== -1) {
              const existing = next[existingIdx];
              const mergedToolCalls = existing.toolCalls
                ? [...existing.toolCalls]
                : toolCalls
                  ? [...toolCalls]
                  : [];
              for (const tc of toolCalls ?? []) {
                if (!mergedToolCalls.find((e) => e.id === tc.id)) {
                  mergedToolCalls.push(tc);
                }
              }
              next[existingIdx] = {
                ...existing,
                content: content || existing.content,
                toolCalls: mergedToolCalls.length > 0 ? mergedToolCalls : null,
                reasoning: reasoning || existing.reasoning || null,
              };
              return next;
            }
            next.push({
              id: msgId || `msg-${Date.now()}`,
              sessionId,
              role: 'assistant',
              content,
              toolCalls: toolCalls || null,
              reasoning: reasoning || null,
              tokensInput: 0,
              tokensOutput: 0,
              createdAt: new Date().toISOString(),
            });
            return next;
          });
        }
        setStreamingText('');
        setStreamingThought('');
        setIsThinking(false);
        break;
      }

      case 'tool.started':
        setIsThinking(false);
        toolStartTimes.current.set(data.toolCallId as string, Date.now());
        setMessages((prev) => {
          const next = [...prev];
          // Find existing tool call
          for (let i = next.length - 1; i >= 0; i--) {
            const msg = next[i];
            if (msg.role === 'assistant' && msg.toolCalls?.length) {
              const tcIdx = msg.toolCalls.findIndex((tc) => tc.id === data.toolCallId);
              if (tcIdx !== -1) {
                const updatedToolCalls = [...msg.toolCalls];
                updatedToolCalls[tcIdx] = { ...updatedToolCalls[tcIdx], status: 'running' };
                next[i] = { ...msg, toolCalls: updatedToolCalls };
                return next;
              }
            }
          }
          // Tool event arrived before text.end created the message — create it
          next.push({
            id: `msg-tc-${data.toolCallId}`,
            sessionId,
            role: 'assistant' as const,
            content: '',
            toolCalls: [{
              id: data.toolCallId as string,
              toolName: (data.toolName as string) || 'unknown',
              arguments: data.args || {},
              status: 'running',
              output: undefined,
              result: undefined,
              error: undefined,
            }],
            tokensInput: 0,
            tokensOutput: 0,
            createdAt: new Date().toISOString(),
          });
          return next;
        });
        break;

      case 'tool.output':
        setMessages((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            const msg = next[i];
            if (msg.role === 'assistant' && msg.toolCalls?.length) {
              const tcIdx = msg.toolCalls.findIndex((tc) => tc.id === data.toolCallId);
              if (tcIdx !== -1) {
                const updatedToolCalls = [...msg.toolCalls];
                updatedToolCalls[tcIdx] = { ...updatedToolCalls[tcIdx], output: data.output as string };
                next[i] = { ...msg, toolCalls: updatedToolCalls };
                return next;
              }
            }
          }
          return next;
        });
        break;

      case 'tool.progress': {
        const toolCallId = data.toolCallId as string;
        if (!toolCallId) break;
        const { toolCallId: _dropped, ...progress } = data;
        const pr = progress as Partial<ToolProgress>;
        const cleanProgress: ToolProgress = {
          kind: pr.kind ?? 'tool',
          path: pr.path,
          percent: pr.percent,
          bytesWritten: pr.bytesWritten,
          bytesTotal: pr.bytesTotal,
          lines: pr.lines,
          linesTotal: pr.linesTotal,
          preview: pr.preview,
          detail: pr.detail,
        };
        setMessages((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            const msg = next[i];
            if (msg.role === 'assistant' && msg.toolCalls?.length) {
              const tcIdx = msg.toolCalls.findIndex((tc) => tc.id === toolCallId);
              if (tcIdx !== -1) {
                const updatedToolCalls = [...msg.toolCalls];
                updatedToolCalls[tcIdx] = {
                  ...updatedToolCalls[tcIdx],
                  progress: {
                    ...cleanProgress,
                    // Persist the newest preview chunk — never let the live
                    // byte counter regress between progress pulses.
                    lines: cleanProgress.lines ?? updatedToolCalls[tcIdx].progress?.lines ?? 0,
                    percent: cleanProgress.percent ?? updatedToolCalls[tcIdx].progress?.percent ?? 0,
                  },
                };
                next[i] = { ...msg, toolCalls: updatedToolCalls };
                return next;
              }
            }
          }
          return next;
        });
        break;
      }

      case 'tool.completed':
        // The agent may have registered a new MCP server via add_mcp_server —
        // refresh the shared store so the composer sidebar stays in sync.
        if (data.toolName === 'add_mcp_server') void refreshMcpList();
        setMessages((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            const msg = next[i];
            if (msg.role === 'assistant' && msg.toolCalls?.length) {
              const tcIdx = msg.toolCalls.findIndex((tc) => tc.id === data.toolCallId);
              if (tcIdx !== -1) {
                const updatedToolCalls = [...msg.toolCalls];
                updatedToolCalls[tcIdx] = { ...updatedToolCalls[tcIdx], status: 'completed', result: data.result };
                next[i] = { ...msg, toolCalls: updatedToolCalls };
                return next;
              }
            }
          }
          // Tool completed before text.end — create message with completed tool call
          next.push({
            id: `msg-tc-${data.toolCallId}`,
            sessionId,
            role: 'assistant' as const,
            content: '',
            toolCalls: [{
              id: data.toolCallId as string,
              toolName: 'unknown',
              arguments: {},
              status: 'completed',
              output: undefined,
              result: data.result,
              error: undefined,
            }],
            tokensInput: 0,
            tokensOutput: 0,
            createdAt: new Date().toISOString(),
          });
          return next;
        });
        toolStartTimes.current.delete(data.toolCallId as string);
        break;

      case 'tool.failed':
        setMessages((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            const msg = next[i];
            if (msg.role === 'assistant' && msg.toolCalls?.length) {
              const tcIdx = msg.toolCalls.findIndex((tc) => tc.id === data.toolCallId);
              if (tcIdx !== -1) {
                const updatedToolCalls = [...msg.toolCalls];
                updatedToolCalls[tcIdx] = { ...updatedToolCalls[tcIdx], status: 'failed', error: data.error as string, output: data.error as string };
                next[i] = { ...msg, toolCalls: updatedToolCalls };
                return next;
              }
            }
          }
          // Tool failed before text.end — create message with failed tool call
          next.push({
            id: `msg-tc-${data.toolCallId}`,
            sessionId,
            role: 'assistant' as const,
            content: '',
            toolCalls: [{
              id: data.toolCallId as string,
              toolName: 'unknown',
              arguments: {},
              status: 'failed',
              output: data.error as string,
              result: undefined,
              error: data.error as string,
            }],
            tokensInput: 0,
            tokensOutput: 0,
            createdAt: new Date().toISOString(),
          });
          return next;
        });
        toolStartTimes.current.delete(data.toolCallId as string);
        break;

      case 'mcp.stock': {
        // The store keeps the payload (mirrored into this panel). Popping the
        // add/enable dialogs is driven by `mcp.approval_required`, which fires
        // AFTER the run PAUSES for the decision — opening here would race the
        // actual pause and show a popup that isn't backed by a held run yet.
        const stock = data as unknown as McpStockPayload;
        if (stock.recommendedToAddIds?.length || stock.recommendedToEnableIds?.length) {
          setMcpEnableOpen(false);
          setMcpAddOpen(false);
        }
        break;
      }

      default:
        break;
    }
  }, [sessionId, streamingThought, refreshMcpList]);


  useEffect(() => {
    handleEventRef.current = handleEvent;
  }, [handleEvent]);

  // ── Module-level session store (survives unmount / navigation) ───────────
  const agentRev = useSyncExternalStore(subscribeAgentStore, getAgentStoreRev, getAgentStoreRev);
  const live = useMemo(() => getSessionLive(sessionId), [agentRev, sessionId]);
  const liveRunning = live.isRunning;

  // Live message events + mcp.stock popups arrive here while mounted; the rest
  // of the run state is mirrored from the store below.
  useEffect(() => {
    const unsubscribe = subscribeSessionEvents(sessionId, (e) => {
      handleEventRef.current(e);
    });
    // If we mounted after a page refresh while the backend was still processing
    // a run, re-attach the panel to the live stream (passive join, no new run).
    // Afterwards, reconcile the parent's top-bar "running" flag with the store.
    void (async () => {
      if (!getSessionLive(sessionId).isRunning) await rejoinRun(sessionId);
      onStatusChange(getSessionLive(sessionId).isRunning);
    })();
    return unsubscribe;
  }, [sessionId, onStatusChange]);

  // Mirror the store's live run state into this panel's local state.
  useEffect(() => {
    setStreamingText(live.streamingText);
    setStreamingThought(live.streamingThought);
    setStepCount(live.stepCount);
    setIsThinking(live.isThinking);
    setIsCompacting(live.isCompacting);
    setLastCompaction(live.lastCompaction);
    setPendingPermission(live.pendingPermission);
    setPendingAskUser(live.pendingAskUser);
    setActiveContexts(live.activeContexts ?? []);
    setTodos(live.todos);
    setMcpStock(live.mcpStock as unknown as McpStockPayload | null);
    setFreeSuggestion(live.freeSuggestion);
    setPendingMcpDecision(live.pendingMcpDecision);
  }, [live, sessionId]);

  // Re-ask: when the store reports a paused MCP approval decision, (re)open the
  // matching popup — including after navigation back or a full page refresh.
  useEffect(() => {
    if (!pendingMcpDecision) return;
    if (pendingMcpDecision.recommendedToAddIds?.length > 0) {
      setMcpAddOpen(true);
      setMcpEnableOpen(false);
    } else if (pendingMcpDecision.recommendedToEnableIds?.length > 0) {
      setMcpAddOpen(false);
      setMcpEnableOpen(true);
    }
  }, [pendingMcpDecision]);

  // Tick `agentStartTimeRef` so the elapsed-timer stays live across re-attaches.
  useEffect(() => {
    if (liveRunning && live.startedAt) {
      agentStartTimeRef.current = live.startedAt;
      // New run → un-dismiss the inline stock card so the freshly-scanned
      // inventory is visible again even if it was dismissed last run.
      setMcpStockDismissed(false);
    } else if (!liveRunning) {
      agentStartTimeRef.current = 0;
    }
  }, [liveRunning, live.startedAt]);

  // Surface run start/end transitions (top-bar Stop state + transcript reload).
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (liveRunning) {
      if (!wasRunningRef.current) onStatusChange(true);
      wasRunningRef.current = true;
    } else {
      if (wasRunningRef.current) {
        onStatusChange(false);
        loadMessages();
      }
      wasRunningRef.current = false;
    }
  }, [liveRunning, onStatusChange, sessionId, loadMessages]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isRunning) return;

    setInput('');
    // Simple mode keeps the process behind one tap — hide details on a new run.
    setShowSteps(false);
    // Collapse the composer back to a single line after sending.
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }
    setMessages((prev) => [...prev, {
      id: `user-${Date.now()}`,
      sessionId,
      role: 'user',
      content: text,
      tokensInput: 0,
      tokensOutput: 0,
      createdAt: new Date().toISOString(),
    }]);

    setStreamingText('');
    setStreamingThought('');
    setIsUserScrolled(false);

    onStatusChange(true);

    try {
      const res = await sessionStartRun(sessionId, text, {
        workspacePath,
        model,
        provider,
        remoteProfileId,
      });
      if (!res.started) {
        // A run is already active for this session — the store keeps it going,
        // so just resurface the already-running state.
        onStatusChange(true);
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        const msg = `Error: ${err instanceof Error ? err.message : 'Failed to start agent'}`;
        setMessages((prev) => [...prev, {
          id: `error-${Date.now()}`,
          sessionId,
          role: 'system',
          content: msg,
          tokensInput: 0,
          tokensOutput: 0,
          createdAt: new Date().toISOString(),
        }]);
        onStatusChange(false);
      }
    }
  }, [input, isRunning, sessionId, workspacePath, model, provider, onStatusChange, remoteProfileId]);

/** Called when the user confirms MCP selections in the enable popup. Resolves
 *  the paused run (enable/skip) instead of injecting a second parallel run,
 *  which the backend rejects while the main run is still active. */
const handleMcpContinue = useCallback(
  async (enabledNames: string[]) => {
    setMcpEnableOpen(false);
    const toolCallId = pendingMcpDecision?.toolCallId ?? '';
    if (enabledNames.length > 0) {
      // Refresh both stores so the UI reflects the newly-enabled servers.
      await refreshMcpList();
      setMcpStock((prev) => {
        if (!prev) return prev;
        const enabledIdSet = new Set(
          prev.servers.filter((s) => enabledNames.includes(s.name)).map((s) => s.id),
        );
        return {
          ...prev,
          servers: prev.servers.map((s) =>
            enabledNames.includes(s.name) ? { ...s, enabled: true } : s,
          ),
          recommendedToEnableIds: prev.recommendedToEnableIds.filter((id) => !enabledIdSet.has(id)),
        };
      });
    }
    // Unpause the run with the user's decision (the backend resumes the loop
    // and folds the choice into the conversation itself).
    try {
      await agentApi.resolveMcpDecision(
        sessionId,
        toolCallId,
        enabledNames.length > 0 ? 'enable' : 'skip',
        enabledNames,
      );
    } catch {
      /* local state already reflects the decision; the next run re-syncs */
    }
    clearLiveMcpDecision(sessionId);
  },
  [pendingMcpDecision, sessionId, refreshMcpList],
);

  /** Called when the user confirms adding new stock MCP servers in the add popup. */
  const handleMcpAddSubmit = useCallback(
    async (added: Array<{ entry: McpStockEntry; env: Record<string, string>; oauth: { clientId: string; clientSecret: string } }>) => {
      if (added.length === 0) {
        setMcpAddOpen(false);
        // Nothing added — let the paused run continue without the recs.
        const toolCallId = pendingMcpDecision?.toolCallId ?? '';
        try {
          await agentApi.resolveMcpDecision(sessionId, toolCallId, 'skip', []);
        } catch {
          /* noop */
        }
        clearLiveMcpDecision(sessionId);
        return;
      }
      const payloads = added.map(({ entry, env, oauth }) => {
        const keysFilled = entry.transport === 'stdio' && entry.envKeys.every((k) => (env[k] ?? '').trim().length > 0);
        const hasKeys = Object.keys(env).length > 0;
        return {
          name: entry.name,
          description: entry.description,
          transport: entry.transport,
          command: entry.transport === 'http' ? undefined : entry.command,
          args: entry.transport === 'http' ? undefined : entry.args,
          url: entry.transport === 'http' ? (entry.url ?? undefined) : undefined,
          env: hasKeys ? env : undefined,
          oauthClientId: oauth.clientId.trim() ? oauth.clientId.trim() : undefined,
          oauthClientSecret: oauth.clientSecret.trim() ? oauth.clientSecret.trim() : undefined,
          oauthScopes: entry.oauthScopes ?? undefined,
          category: entry.category ?? undefined,
          tags: entry.tags?.length ? entry.tags : undefined,
          enabled: entry.transport === 'stdio' && (keysFilled || entry.envKeys.length === 0),
        };
      });
      let res: Awaited<ReturnType<typeof api.createMcpServersBatch>>;
      try {
        res = await api.createMcpServersBatch(payloads);
      } catch (err: any) {
        // Surface the failure instead of swallowing it — the popup stays open
        // so the user can fix validation/keys and retry.
        const msg = err instanceof Error ? err.message : 'Failed to create MCP servers';
        setMessages((prev) => [...prev, {
          id: `error-${Date.now()}`,
          sessionId,
          role: 'system',
          content: `MCP setup failed: ${msg}`,
          tokensInput: 0,
          tokensOutput: 0,
          createdAt: new Date().toISOString(),
        }]);
        return;
      }
      await refreshMcpList();
      const addedNames = new Set(res.created.map((c) => c.name));
      const idByName = new Map(res.created.map((c) => [c.name, c.id]));
      const enabledCount = res.created.filter((c) => !c.needsSetup).length;
      setMcpStock((prev) => {
        if (!prev) return prev;
        const recommendedToAddIds = (prev.recommendedToAddIds ?? []).filter((id) => {
          const e = prev.servers.find((s) => s.id === id);
          return !(e && addedNames.has(e.name));
        });
        return {
          ...prev,
          servers: prev.servers.map((s) =>
            addedNames.has(s.name)
              ? {
                  ...s,
                  id: idByName.get(s.name) ?? s.id,
                  added: true,
                  configured: !res.created.find((c) => c.name === s.name)?.needsSetup,
                  enabled: !res.created.find((c) => c.name === s.name)?.needsSetup,
                  recommendedToAdd: false,
                }
              : s,
          ),
          recommendedToAddIds,
          counts: {
            ...prev.counts,
            configured: prev.counts.configured + res.created.length,
            added: prev.counts.added + res.created.length,
            enabled: prev.counts.enabled + enabledCount,
            stockNotAdded: Math.max(0, prev.counts.stockNotAdded - res.created.length),
          },
        };
      });
      setMcpAddOpen(false);
      const createdNames = res.created.map((c) => c.name);
      // Unpause the run with the decision — the backend resumes the loop and
      // folds the created-server list into the conversation itself.
      const toolCallId = pendingMcpDecision?.toolCallId ?? '';
      try {
        await agentApi.resolveMcpDecision(sessionId, toolCallId, 'add', createdNames);
      } catch {
        /* local state already reflects the decision; the next run re-syncs */
      }
      clearLiveMcpDecision(sessionId);
    },
    [pendingMcpDecision, sessionId, refreshMcpList],
  );

  /**
   * Adds a stock-catalog (not-yet-added) MCP server from the widget. Simple
   * stdio servers are created enabled; anything needing OAuth/keys is created
   * disabled and the user finishes it on the MCP page.
   */
  const handleStockAdd = useCallback(async (entry: McpStockEntry) => {
    const already = mcpServers.some((s) => s.name.trim().toLowerCase() === entry.name.trim().toLowerCase());
    if (already) {
      setMcpStock((prev) => {
        if (!prev) return prev;
        const existing = mcpServers.find((s) => s.name.trim().toLowerCase() === entry.name.trim().toLowerCase());
        return {
          ...prev,
          servers: prev.servers.map((s) =>
            s.id === entry.id
              ? { ...s, added: true, id: existing?.id ?? s.id, enabled: false, configured: true }
              : s,
          ),
        };
      });
      return;
    }
    setStockAction({ id: entry.id, status: 'adding' });
    try {
      const needsSetup = entry.transport === 'http' || entry.envKeys.length > 0;
      const res = await api.createMcpServer({
        name: entry.name,
        description: entry.description,
        transport: entry.transport,
        command: entry.transport === 'http' ? '' : entry.command,
        args: entry.transport === 'http' ? [] : entry.args,
        url: entry.transport === 'http' ? (entry.url ?? undefined) : undefined,
        oauthScopes: entry.oauthScopes ?? undefined,
        category: entry.category ?? undefined,
        tags: entry.tags?.length ? entry.tags : undefined,
        enabled: !needsSetup,
      });
      if (res.existing) {
        setMcpStock((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            servers: prev.servers.map((s) =>
              s.id === entry.id ? { ...s, added: true, id: res.id, configured: true, enabled: res.enabled } : s,
            ),
          };
        });
        return;
      }
      await refreshMcpList();
      setMcpStock((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          servers: prev.servers.map((s) =>
            s.id === entry.id
              ? { ...s, added: true, id: res.id, enabled: !needsSetup, configured: !needsSetup }
              : s,
          ),
          counts: {
            ...prev.counts,
            configured: prev.counts.configured + 1,
            added: prev.counts.added + 1,
            stockNotAdded: Math.max(0, prev.counts.stockNotAdded - 1),
            enabled: prev.counts.enabled + (!needsSetup ? 1 : 0),
          },
        };
      });
      setStockAction({ id: entry.id, status: 'done' });
      if (needsSetup) {
        // Route them to the MCP page to connect OAuth / fill keys.
        window.setTimeout(() => {
          window.location.href = `/mcp?server=${encodeURIComponent(res.id)}`;
        }, 900);
      }
    } catch {
      setStockAction({ id: entry.id, status: 'error', message: 'Failed to add server' });
    }
  }, [refreshMcpList, mcpServers]);

  /** "Add MCP server" from the suggestion card (no auto-recommendation pending):
   *  fetches the FULL stock catalog and opens the Add dialog so the user can
   *  pick any catalog server in-session. Falls back to the MCP page if the
   *  catalog fetch fails. */
  const handleAddMore = useCallback(async () => {
    try {
      const cat = await api.listMcpStockCatalog();
      const existingByName = new Map(
        mcpServers.map((s) => [s.name.trim().toLowerCase(), s]),
      );
      const rows: McpStockEntry[] = (cat.categories ?? []).flatMap((c) =>
        (c.entries ?? []).map((e) => {
          const existing = existingByName.get(e.name.trim().toLowerCase());
          return {
            id: existing ? existing.id : `stock:${e.name}`,
            name: e.name,
            label: e.label,
            description: e.description,
            category: e.category ?? c.label,
            transport: e.transport,
            command: e.command,
            args: e.args,
            url: e.url,
            icon: e.icon,
            enabled: existing ? existing.enabled : false,
            configured: !!existing,
            oauthRegistered: existing?.oauthConnected ?? (e.remote || e.manualOAuth),
            oauthConnected: existing?.oauthConnected ?? false,
            oauthExpiresAt: existing?.oauthExpiresAt ?? null,
            oauthExpired: false,
            envKeys: e.envKeys,
            activeInRun: false,
            added: !!existing,
            keyGetUrl: e.keyGetUrl,
            keyGetLabel: e.keyGetLabel,
            dependency: e.dependency,
            remote: e.remote,
            manualOAuth: e.manualOAuth,
            oauthScopes: e.oauthScopes,
            recommended: false,
            recommendedToEnable: false,
            recommendedToAdd: false,
            tags: e.tags ?? [],
          };
        }),
      );
      setMcpCatalog(rows);
      setMcpAddOpen(true);
    } catch {
      window.location.href = '/mcp';
    }
  }, [mcpServers]);

  /** Inline enable for an already-configured stock server from the card:
   *  flips `enabled` on directly (stdio, no keys/OAuth needed). */
  const handleStockEnable = useCallback(async (entry: McpStockEntry) => {
    if (mcpInlineEnableBusy) return;
    setMcpInlineEnableBusy(entry.id);
    try {
      await api.updateMcpServer(entry.id, { enabled: true });
      await refreshMcpList();
      setMcpStock((prev) =>
        prev
          ? {
              ...prev,
              servers: prev.servers.map((s) => (s.id === entry.id ? { ...s, enabled: true } : s)),
              counts: { ...prev.counts, enabled: prev.counts.enabled + 1 },
            }
          : prev,
      );
    } catch {
      setStockAction({ id: entry.id, status: 'error', message: 'Failed to enable server' });
    } finally {
      setMcpInlineEnableBusy(null);
    }
  }, [mcpInlineEnableBusy, refreshMcpList]);

  /** Inline OAuth connect for an added-but-not-authorized HTTP server shown in
   *  the MCP bar. Opens the provider's authorize URL in the system browser,
   *  then polls until the server reports connected (never navigates away from
   *  the agent panel). */
  const handleInlineOAuth = useCallback(async (row: McpStockEntry) => {
    if (mcpOauthConnecting) return;
    const serverId = row.id; // configured stock rows carry the real server id
    if (!serverId) return;
    setMcpOauthConnecting(row.id);
    try {
      const res = await api.startMcpOAuth(serverId);
      await openExternalUrl(res.authUrl);
      const start = Date.now();
      while (Date.now() - start < 120_000) {
        await new Promise((r) => setTimeout(r, 2000));
        const { servers } = await api.listMcpServers();
        const fresh = servers.find((s) => s.id === serverId);
        if (fresh?.oauthConnected) {
          setMcpStock((prev) =>
            prev
              ? {
                  ...prev,
                  servers: prev.servers.map((s) =>
                    s.id === row.id ? { ...s, oauthConnected: true, oauthExpired: false } : s,
                  ),
                }
              : prev,
          );
          await refreshMcpList();
          break;
        }
      }
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : '';
      // No DCR + no user-supplied client → offer the personal-access-token path
      if (
        msg.includes('does not support automatic client registration') ||
        msg.includes('consumer credentials') ||
        msg.includes('needs your own') ||
        msg.includes('OAuth not supported by') ||
        msg.includes('no resource metadata')
      ) {
        setTokenPromptRow(row);
      }
      setMcpStock((prev) =>
        prev
          ? {
              ...prev,
              servers: prev.servers.map((s) =>
                s.id === row.id ? { ...s, oauthConnected: false } : s,
              ),
            }
          : prev,
      );
    } finally {
      setMcpOauthConnecting(null);
    }
  }, [mcpOauthConnecting, refreshMcpList]);

  /** Closing either popup without a submission = the user skipped the
   *  recommendation — resolve the paused run with `skip` so it doesn't stay
   *  blocked, then clear the persisted decision. */
  const handleMcpDismiss = useCallback(async () => {
    setMcpEnableOpen(false);
    setMcpAddOpen(false);
    const toolCallId = pendingMcpDecision?.toolCallId ?? '';
    try {
      await agentApi.resolveMcpDecision(sessionId, toolCallId, 'skip', []);
    } catch {
      /* noop */
    }
    clearLiveMcpDecision(sessionId);
  }, [pendingMcpDecision, sessionId]);

  const handleInterrupt = useCallback(async () => {
    try {
      onStatusChange(false);
      await sessionStopRun(sessionId);
      // Reload so the interrupted transcript (and any messages persisted up to
      // the stop point) is shown instead of leftover live-streaming state.
      loadMessages();
    } catch { /* ignore */ }
  }, [sessionId, onStatusChange, loadMessages]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  // Build the inline conversation flow:
  //  PRIMARY   conversation (user ↔ assistant markdown)
  //  SECONDARY agent activity groups (◎ Inspecting / ● Editing / ◌ Verifying)
  //  TERTIARY  individual tool rows (collapsed by default)
  //  DETAIL    expanded arguments/output
  const renderConversation = () => {
    const elements: React.ReactNode[] = [];
    let firstAgentMsg = false;

    // Wrapper for an assistant message. The monkey avatar shows exactly once,
    // above the agent's very first message — never repeated per message or run.
    const agentBubble = (key: string, content: ReactNode) => {
      const first = !firstAgentMsg;
      firstAgentMsg = true;
      return (
        <div key={key} className="animate-fade-in">
          <div className={cn('flex items-start', first ? 'gap-2.5' : '')}>
            {first && <AgentAvatar />}
            <div className="min-w-0 flex-1">{content}</div>
          </div>
        </div>
      );
    };

    // ── Tool-run chaining ─────────────────────────────────────────────────
    // Consecutive tool calls of the SAME family are joined into one vertical
    // rail "run" — even when they arrive in separate messages (separated only
    // by reasoning or tool-result messages). A real answer, user message,
    // notice, or compaction breaks the chain. Rows keep their DOM order; each
    // run gets a single phase header + connector line. This is what lets 6
    // consecutive reads render as one joined chain instead of 6 loose dots.
    type RunPos = 'first' | 'mid' | 'last' | 'only';
    interface ToolItem { id: string; meta: ToolMeta; tc: TcShape; msgId: string; barrierSincePrev: boolean }
    interface RunInfo { runId: string; pos: RunPos; index: number; total: number; label: string; meta: ToolMeta }

    const toolItems: ToolItem[] = [];
    let pendingBarrier = hasMoreOlder || isCompacting || !!lastCompaction || !!freeSuggestion
      || activeContexts.length > 0 || (todos !== null && todos.length > 0);
    messages.forEach((msg) => {
      if (msg.role === 'user' || msg.role === 'system') {
        pendingBarrier = true;
      } else if (msg.role === 'assistant') {
        if (msg.content) pendingBarrier = true;
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            toolItems.push({ id: tc.id, meta: metaFor(tc.toolName), tc, msgId: msg.id, barrierSincePrev: pendingBarrier });
            pendingBarrier = false;
          }
        }
      }
    });

    const chainById = new Map<string, RunInfo>();
    {
      let acc: ToolItem[] = [];
      let meta: ToolMeta | null = null;
      const flush = () => {
        if (acc.length === 0) return;
        const runId = acc[0].id;
        const total = acc.length;
        acc.forEach((it, i) => {
          const pos: RunPos = total === 1 ? 'only' : i === 0 ? 'first' : i === total - 1 ? 'last' : 'mid';
          chainById.set(it.id, { runId, pos, index: i, total, label: FAMILY_LABELS[meta!.family], meta: meta! });
        });
        acc = [];
      };
      for (const it of toolItems) {
        if (acc.length > 0 && (it.barrierSincePrev || it.meta.family !== meta!.family)) flush();
        meta = it.meta;
        acc.push(it);
      }
      flush();
    }
    const emittedRuns = new Set<string>();
    // Last emitted tool row — used to keep the rail line continuous through a
    // mid-run reasoning card, and to tuck joined rows tightly together.
    const lastRun = { id: null as string | null, index: 0, total: 0 };

    // Older messages are loaded on demand (scroll-up / button) rather than
    // fetching a fixed window, so long chats never lose their earlier history.
    if (hasMoreOlder) {
      elements.push(
        <div key="load-earlier" className="flex justify-center py-2">
          <button
            type="button"
            disabled={loadingOlder}
            onClick={loadOlderMessages}
            className="flex items-center gap-1.5 rounded-full border border-border/40 px-3 py-1 text-[11px] text-ink-muted transition-colors hover:border-primary/30 hover:text-foreground disabled:opacity-50"
          >
            {loadingOlder ? (
              <span className="flex items-center gap-1.5">
                <ThinkingIndicator /> Loading earlier messages…
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <ChevronUp className="h-3 w-3" /> Load earlier messages
              </span>
            )}
          </button>
        </div>,
      );
    }

    // Live compaction progress + last-result notice
    if (isCompacting) {
      elements.push(<CompactingBanner key="compacting-live" tokensBefore={lastCompaction?.tokensBefore} />);
    } else if (lastCompaction) {
      elements.push(
        <CompactedNotice
          key="compacted-notice"
          tokensBefore={lastCompaction.tokensBefore}
          tokensAfter={lastCompaction.tokensAfter}
          tokensSaved={lastCompaction.tokensSaved}
          summary={lastCompaction.summary}
        />,
      );
    }

    // Free-token-exhaustion suggestion card (shows after a failed run).
    if (freeSuggestion) {
      elements.push(
        <FreeModelSuggestionCard
          key="free-suggestion"
          error={freeSuggestion}
          currentProvider={provider || 'omniroute'}
          onSwitchToFree={(p, m) => {
            onModelChange?.(p, m);
            setFreeSuggestion(null);
            clearLiveFreeSuggestion(sessionId);
          }}
          onDismiss={() => {
            setFreeSuggestion(null);
            clearLiveFreeSuggestion(sessionId);
          }}
        />,
      );
    }

    // Sticky sub-prompt bar: the live sub-context panel stays pinned to the
    // top of the scroll area so the agent's context is always visible instead
    // of scrolling away with the conversation.
    // (Shown in both modes — simple shows the same collapsible cards.)
    // When the side rail is active the same cards are rendered once in the
    // left column, so the inline copy is skipped.
    const showBar = activeContexts.length > 0 || (todos !== null && todos.length > 0);
    if (showBar && !sideRailActive) {
      elements.push(
        <div key="sticky-bar" className="agent-status-rail">
          <ContextBar key="context-bar" active={activeContexts} servers={mcpServers} />
          {todos !== null && todos.length > 0 && <TodoList key="todo-list" todos={todos} />}
        </div>,
      );
    }

    messages.forEach((msg) => {
      if (msg.role === 'user') {
        elements.push(
          <div key={msg.id} className="flex animate-fade-in justify-end">
            <div className="max-w-[85%] rounded-2xl rounded-br-md bg-surface-800/95 px-3.5 py-2 text-sm text-ink-primary ring-1 ring-white/[0.05] shadow-sm shadow-black/20">
              <div className="whitespace-pre-wrap break-words leading-relaxed">{msg.content}</div>
            </div>
          </div>
        );
      } else if (msg.role === 'system') {
        // Engine/agent notices (nudges, errors) — subtle inline status, not a
        // yellow warning box. Errors get a red tint, everything else stays calm.
        const isError = /error|failed|aborted|stopping|rate.?limit|quota|timed out|forbidden|unauthorized|\(4\d\d\)|\(5\d\d\)/i.test(msg.content);
        elements.push(
          <div
            key={msg.id}
            className={cn(
              'flex items-start gap-1.5 px-1 py-0.5 text-[11px] leading-relaxed',
              isError ? 'text-red-300/80' : 'text-ink-muted/70',
            )}
          >
            {isError ? (
              <AlertCircle className="mt-0.5 h-3 w-3 shrink-0 text-red-400/70" />
            ) : (
              <Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-amber-300/50" />
            )}
            <div className="min-w-0 whitespace-pre-wrap break-words">{msg.content}</div>
          </div>
        );
      } else if (msg.role === 'tool') {
        // Tool messages are handled by toolCalls on assistant messages, skip
      } else if (msg.role === 'assistant') {
        // Render the model's persisted reasoning as a foldable "Planning"
        // section above the answer (Simple mode: hidden until details are shown).
        if (msg.reasoning && !(simple && !showSteps)) {
          // When this thought sits between rows of the SAME run, keep the rail
          // line running through it so the chain reads as one joined timeline.
          const midChain = lastRun.id != null && lastRun.index < lastRun.total - 1;
          elements.push(
            <div key={`${msg.id}-thought`}>
              <ThoughtSection text={msg.reasoning} rail={midChain} />
            </div>
          );
        }
        // Render content (the conversation — PRIMARY)
        if (msg.content) {
          elements.push(
            agentBubble(msg.id, <MarkdownRenderer content={msg.content} onFileSelect={onFileSelect} />),
          );
        }
        // Render tool calls as compact activity rows, one per call, joined by
        // the rail connectors computed into chainById (same family across
        // messages → one chain).
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          msg.toolCalls.forEach((tc, i) => {
            const info = chainById.get(tc.id);
            if (!info) return;
            if (!emittedRuns.has(info.runId)) {
              emittedRuns.add(info.runId);
              elements.push(<ActivityHeader key={`h-${info.runId}`} label={info.label} count={info.total} />);
            }
            const startTime = toolStartTimes.current.get(tc.id);
            const mcp = parseMcpToolName(tc.toolName);
            const customIcon = mcp ? (mcpIconByServer.get(mcp.serverName.trim().toLowerCase()) ?? null) : undefined;
            const prevRun = lastRun.id;
            lastRun.id = info.runId;
            lastRun.index = info.index;
            lastRun.total = info.total;
            elements.push(
              <ToolRow
                key={`tc-${tc.id}-${i}`}
                tc={tc}
                startTime={startTime}
                onFileSelect={onFileSelect}
                customIcon={customIcon}
                rail={info.pos}
                tight={prevRun === info.runId}
              />
            );
          });
        }
      }
    });

    // Render the live model reasoning stream as a foldable "Planning"
    // section that appears as soon as thinking deltas arrive. Shown in both
    // Simple and Developer modes so the thought is always visible live.
    if (streamingThought) {
      elements.push(
        <div key="streaming-thought">
          <ThoughtSection text={streamingThought} streaming />
        </div>
      );
    }

    // Render streaming text (PRIMARY)
    if (streamingText) {
      elements.push(
        agentBubble('streaming', (
          <>
            <MarkdownRenderer content={streamingText} onFileSelect={onFileSelect} />
            <span className="ml-1 inline-block h-3.5 w-[3px] rounded-full bg-gradient-to-b from-amber-400 via-amber-300 to-accent align-text-bottom animate-pulse-soft" />
          </>
        )),
      );
    }

    // Show thinking indicator when running but no text/tools yet
    if (isRunning && isThinking && !streamingText) {
      const lastMsg = messages[messages.length - 1];
      const hasLiveTools = lastMsg?.role === 'assistant' && lastMsg.toolCalls?.some((tc) => tc.status === 'running');
      if (!hasLiveTools) {
        elements.push(
          <div key="thinking">
            <ThinkingIndicator />
          </div>
        );
      }
    }

    // Awaiting user permission — render an inline confirm row IN the chat
    // timeline (contextual, right where the agent is working), not a floating
    // box below. Allow proceeds with the tool; Deny cancels it.
    if (pendingPermission) {
      const args = (pendingPermission.args || {}) as Record<string, unknown>;
      const cmd = typeof args.command === 'string' ? args.command : '';
      const filePath = typeof args.path === 'string' ? args.path : '';
      const isFileTool = ['read_file', 'edit_file', 'write_file', 'replace_lines', 'line_edit', 'apply_patch', 'delete_file'].includes(pendingPermission.toolName);
      elements.push(
        <div key="permission-inline" className="ml-6 my-1 overflow-hidden rounded-lg border border-yellow-500/25 bg-yellow-500/[0.06]">
          <div className="flex items-center gap-1.5 px-2.5 py-1.5">
            <AlertCircle className="h-3 w-3 shrink-0 text-yellow-500/80" />
            <p className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
              Allow <span className="font-mono text-yellow-500/90">{pendingPermission.toolName}</span>
              {cmd
                ? ' — run this command in the terminal'
                : isFileTool
                  ? ' — access this file'
                  : ' — use this tool'}?
            </p>
          </div>
          {(cmd || filePath) && (
            <pre className="mx-2.5 mb-2 overflow-x-auto rounded bg-black/30 p-1.5 font-mono text-[11px] text-ink-secondary break-all whitespace-pre-wrap">
              {cmd || filePath}
            </pre>
          )}
          <div className="flex gap-1.5 px-2.5 pb-2">
            <button
              onClick={async () => {
                if (pendingPermission) {
                  await agentApi.resolvePermission(pendingPermission.toolCallId, 'allow');
                  setPendingPermission(null);
                  clearLivePermission(sessionId);
                }
              }}
              className="flex items-center gap-1 rounded-md bg-green-600 px-2.5 py-1 text-[11px] text-white hover:bg-green-700 transition-colors"
            >
              <Check className="h-3 w-3" /> Allow
            </button>
            <button
              onClick={async () => {
                if (pendingPermission) {
                  await agentApi.resolvePermission(pendingPermission.toolCallId, 'deny');
                  setPendingPermission(null);
                  clearLivePermission(sessionId);
                }
              }}
              className="flex items-center gap-1 rounded-md bg-red-600 px-2.5 py-1 text-[11px] text-white hover:bg-red-700 transition-colors"
            >
              <X className="h-3 w-3" /> Deny
            </button>
          </div>
        </div>,
      );
    }

    // ── Inline MCP stock card ──────────────────────────────────────────
    // Rendered at the end of the conversation so the inventory the agent just
    // scanned with inspect_mcp_stock stays visible (with one-tap Add / Enable /
    // Connect-OAuth for the servers it recommends). Hidden while a paused MCP
    // approval popup is up — that popup owns the decision.
    if (mcpStock && !mcpStockDismissed && mcpStock.servers.length > 0
      && !pendingMcpDecision
      && !(mcpEnableOpen || mcpAddOpen)) {
      elements.push(
        <div key="mcp-stock-inline" className="pr-[2px]">
          <McpStockInline
            stock={mcpStock}
            stockAction={stockAction}
            oauthConnecting={mcpOauthConnecting}
            onAdd={handleStockAdd}
            onOAuth={handleInlineOAuth}
            onEnable={handleStockEnable}
            onAddMore={handleAddMore}
            onDismiss={() => setMcpStockDismissed(true)}
          />
        </div>,
      );
    }

    return elements;
  };
  // Track the composer width so crowded action-bar items can wrap/compress
  // gracefully when the agent panel is dragged narrow.
  useEffect(() => {
    const el = composerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setComposerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Track the chat panel width. When the workspace left sidebar / edit-code
  // bar is closed there is room for the live status rail as a proper side
  // column; when the panel is narrow the cards stay in their current inline
  // sticky position.
  useEffect(() => {
    const el = chatRootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setChatWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const composerNarrow = composerWidth > 0 && composerWidth < 360;

  // Side-rail mode: only when there is genuinely room (left side free), there
  // is something to show, and work is still pending. Once every todo is done
  // the column closes and the chat reclaims the full width.
  const todosAllDone =
    todos !== null && todos.length > 0 &&
    todos.every((t) => t.status === 'completed' || t.status === 'cancelled');
  const roomForRail = chatWidth === 0 || chatWidth >= 720;
  const sideRailActive =
    !railDismissed &&
    roomForRail &&
    !todosAllDone &&
    (activeContexts.length > 0 || (todos !== null && todos.length > 0));

  // Shared transcript body: empty state + conversation + scroll anchor.
  // Rendered inside a centered column in simple mode (scrollbar pinned to the
  // far right edge of the chat area) and full-width in dev mode.
  const messagesContent = (
    <>
      {messages.length === 0 && !streamingText && !isRunning && (
        <div className={cn('flex flex-col items-center justify-center text-center', simple ? 'flex-1' : 'h-full')}>
          <div className="flex flex-col items-center">
            <BrandIcon size={simple ? 96 : 64} className="rounded-xl" />
            <h3 className={cn('mt-4 font-semibold leading-tight text-foreground/95', simple ? 'text-xl' : 'text-base')}>
              {simple ? 'What would you like to do?' : 'Smoke Monkey'}
            </h3>
            <p className={cn('mt-1.5 max-w-sm leading-relaxed text-ink-muted/75', simple ? 'text-sm' : 'text-xs')}>
              {simple
                ? 'I work in your project — ask me to build, fix, answer, or create anything.'
                : 'Build, debug, and modify your codebase.'}
            </p>
          </div>

          <div className={cn('mt-6 flex flex-wrap items-center justify-center', simple ? 'gap-1.5' : 'grid w-full max-w-sm grid-cols-2 gap-1.5')}>
            {[
              'Fix the failing tests',
              'Explain this code',
              'Add a feature',
              'Find a bug',
            ].map((prompt) => (
              <button
                key={prompt}
                onClick={() => { setInput(prompt); inputRef.current?.focus(); }}
                className={cn(
                  'rounded-xl text-[11px] text-ink-muted transition-all duration-150 hover:border-primary/35 hover:text-foreground',
                  simple
                    ? 'border border-border/40 bg-surface-900/60 px-4 py-2 backdrop-blur hover:bg-surface-800/80'
                    : 'rounded-lg border border-border/50 bg-surface-900/60 px-2.5 py-2 text-left hover:bg-surface-800',
                )}
              >
                {prompt}
              </button>
            ))}
          </div>

          {!simple && ideAvailable && (
            <button
              onClick={async () => {
                try {
                  if (window.__TAURI_INTERNALS__) {
                    await window.__TAURI_INTERNALS__.invoke('open_in_ide', { workspacePath });
                  }
                } catch (e) {
                  console.error('Failed to open in IDE:', e);
                }
              }}
              className="mt-5 flex items-center gap-1.5 rounded-md border border-border/40 px-3 py-1.5 text-[11px] text-ink-muted transition-colors hover:text-foreground"
            >
              <Code2 className="h-3 w-3" /> Open in Smoke Monkey IDE
            </button>
          )}
        </div>
      )}

      {renderConversation()}

      <div ref={messagesEndRef} />
    </>
  );

  const dialogStock: McpStockPayload | null =
    mcpAddOpen && mcpCatalog
      ? {
          query: null,
          category: null,
          task: null,
          categories: [],
          servers: mcpCatalog,
          recommendedIds: [],
          recommendedToEnableIds: [],
          recommendedToAddIds: [],
          counts: {
            total: mcpCatalog.length,
            configured: 0,
            added: 0,
            enabled: 0,
            active: 0,
            needAttention: 0,
            stockNotAdded: mcpCatalog.length,
            stockAdded: 0,
            stockCategories: 0,
          },
        }
      : (mcpStock ?? (pendingMcpDecision
          ? {
        query: null,
        category: null,
        task: pendingMcpDecision.task,
        categories: [],
        servers: (pendingMcpDecision.servers ?? []) as McpStockEntry[],
        recommendedIds: ((pendingMcpDecision.servers ?? []) as McpStockEntry[])
          .filter((s) => s.recommended)
          .map((s) => s.id),
        recommendedToEnableIds: pendingMcpDecision.recommendedToEnableIds ?? [],
        recommendedToAddIds: pendingMcpDecision.recommendedToAddIds ?? [],
        counts: {
          total: (pendingMcpDecision.servers ?? []).length,
          configured: 0,
          added: 0,
          enabled: 0,
          active: 0,
          needAttention: 0,
          stockNotAdded: 0,
          stockAdded: 0,
          stockCategories: 0,
        },
      }
    : null));

  return (
    <div ref={chatRootRef} className="flex h-full flex-col bg-background">
      {/* Chat header — hidden in simple mode (the shell shows one merged top bar). */}
      {!simple && (
      <div className="relative flex h-9 shrink-0 items-center gap-1.5 border-b border-border/40 px-3">
        <span className="min-w-0 flex-1 truncate pl-1 text-xs font-medium text-foreground/85">
          {sessions.find((s) => s.id === activeSessionId)?.title || 'Smoke Monkey'}
        </span>
        {onNewSession && (
          <button
            onClick={onNewSession}
            title="New chat"
            aria-label="New chat"
            className="glass-hover rounded-md p-1 text-ink-muted transition-colors hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
        {(onSelectSession || onNewSession) && (
          <button
            onClick={() => setHistoryOpen((v) => !v)}
            title="Chat history"
            aria-label="Chat history"
            aria-expanded={historyOpen}
            className={cn(
              'glass-hover rounded-md p-1 transition-colors',
              historyOpen ? 'text-foreground' : 'text-ink-muted hover:text-foreground',
            )}
          >
            <History className="h-3.5 w-3.5" />
          </button>
        )}

        {/* Recent chats dropdown */}
        {historyOpen && onSelectSession && (
          <>
            <button
              aria-label="Close chat history"
              onClick={() => setHistoryOpen(false)}
              className="fixed inset-0 z-20 cursor-default bg-transparent"
            />
            <div className="absolute left-2 right-2 top-full z-30 mt-1 max-h-80 overflow-y-auto glass-panel rounded-lg border border-border/60 p-1.5 shadow-xl scrollbar-thin">
              {(() => {
                const now = new Date();
                const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
                const groups: Array<{ label: string; items: AgentSession[] }> = [
                  { label: 'Today', items: [] },
                  { label: 'Yesterday', items: [] },
                  { label: 'Older', items: [] },
                ];
                for (const s of sessions) {
                  const t = new Date(s.updatedAt).getTime();
                  if (t >= startOfToday) groups[0].items.push(s);
                  else if (t >= startOfToday - 86_400_000) groups[1].items.push(s);
                  else groups[2].items.push(s);
                }
                return (
                  <>
                    {groups.map(({ label, items }) =>
                      items.length === 0 ? null : (
                        <div key={label} className="mb-0.5">
                          <p className="px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-ink-muted">{label}</p>
                          {items.map((s) => (
                            <button
                              key={s.id}
                              onClick={() => { onSelectSession(s); setHistoryOpen(false); }}
                              className={cn(
                                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.05]',
                                s.id === activeSessionId && 'bg-primary-subtle',
                              )}
                            >
                              <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', s.status === 'running' ? 'bg-blue-400' : s.status === 'completed' ? 'bg-green-400' : s.status === 'failed' ? 'bg-red-400' : s.status === 'interrupted' ? 'bg-yellow-400' : 'bg-zinc-500')} />
                              <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{s.title || 'Untitled'}</span>
                              <span className="shrink-0 text-[9px] text-ink-muted">{s.messageCount ?? 0} msgs</span>
                            </button>
                          ))}
                        </div>
                      ),
                    )}
                    {sessions.length === 0 && (
                      <p className="px-2 py-3 text-center text-[10px] text-ink-muted">No chats yet</p>
                    )}
                  </>
                );
              })()}
            </div>
          </>
        )}
      </div>
      )}

      {/* Status line */}
      <AgentStatusIndicator
        stepCount={stepCount}
        duration={duration}
        isRunning={isRunning}
        streamingText={streamingText}
        messages={messages}
        simple={simple}
      />

      {/* Toolbar */}
      {!simple && !isRunning && messages.length > 0 && (
        <div className="flex items-center justify-between px-4 py-1">
          <div className="flex items-center gap-2">
            {indexStats && (
              <span
                title={
                  indexStats.error
                    ? 'Workspace index error: ' + indexStats.error
                    : indexStats.ready
                      ? 'SQLite workspace index — find_symbol / search_code resolve instantly'
                      : 'Workspace index not built yet for this project'
                }
                className="flex items-center gap-1.5 rounded-full border border-border/40 bg-surface-900/50 px-2 py-0.5 text-[10px] text-ink-muted/70"
              >
                <span className={cn('h-1.5 w-1.5 rounded-full', indexStats.ready ? 'bg-emerald-400' : 'bg-amber-400')} />
                {indexStats.ready
                  ? `Index: ${indexStats.files.toLocaleString()} files · ${indexStats.symbols.toLocaleString()} sym`
                  : 'Index: building…'}
              </span>
            )}
          </div>
          {ideAvailable && (
            <button
              onClick={async () => {
                try {
                  if (window.__TAURI_INTERNALS__) {
                    await window.__TAURI_INTERNALS__.invoke('open_in_ide', { workspacePath });
                  }
                } catch (e) {
                  console.error('Failed to open in IDE:', e);
                }
              }}
              className="flex items-center gap-1 text-[10px] text-ink-muted/60 hover:text-foreground transition-colors"
            >
              <Code2 className="h-3 w-3" /> Open in IDE
            </button>
          )}
        </div>
      )}

      {/* Messages area — in simple mode the scroll container runs edge to edge
          (scrollbar pinned to the far right) while the transcript stays
          centered inside a max-width column. When the panel is wide enough the
          live status rail becomes a left-hand column and the chat is pushed to
          the right. */}
      <div className="flex min-h-0 flex-1">
        {sideRailActive && (
          <aside className="agent-side-rail">
            <div className="agent-side-rail__header">
              <span className="agent-side-rail__title">Status</span>
              <button
                type="button"
                onClick={() => setRailDismissed(true)}
                className="agent-side-rail__close"
                title="Close the side rail — status moves back to the top of the chat"
                aria-label="Close side rail"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <TodoTimeline key="todo-list" todos={todos ?? []} />
            <ContextBar key="context-bar" active={activeContexts} servers={mcpServers} variant="side" />
          </aside>
        )}
        <div className="flex min-h-0 flex-1 flex-col">
          {simple ? (
          <div
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="flex-1 scrollbar-thin overflow-y-auto"
          >
            <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col space-y-1.5 px-4 py-5 sm:px-6">
              {messagesContent}
            </div>
          </div>
        ) : (
          <div
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="flex-1 scrollbar-thin overflow-y-auto"
          >
            <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col space-y-1.5 px-4 py-4 sm:px-6">
              {messagesContent}
            </div>
          </div>
        )}

      {/* Ask user dialog */}
      <AskUserDialog
        open={!!pendingAskUser}
        question={pendingAskUser?.question || ''}
        options={pendingAskUser?.options || []}
        multiple={Boolean(pendingAskUser?.multiple)}
        onResolve={async (response) => {
          if (pendingAskUser) {
            await agentApi.resolveAskUser(pendingAskUser.toolCallId, response);
            setPendingAskUser(null);
            clearLiveAskUser(sessionId);
          }
        }}
        onDismiss={async () => {
          if (pendingAskUser) {
            await agentApi.resolveAskUser(pendingAskUser.toolCallId, '(user skipped)');
            setPendingAskUser(null);
            clearLiveAskUser(sessionId);
          }
        }}
      />

      {/* MCP enable popup */}
      <McpEnableDialog
        open={mcpEnableOpen && !!dialogStock}
        stock={dialogStock}
        onClose={handleMcpDismiss}
        onContinue={handleMcpContinue}
      />

      {/* MCP add-from-stock popup */}
      <McpAddDialog
        open={mcpAddOpen && !!dialogStock}
        stock={dialogStock}
        onClose={handleMcpDismiss}
        onSubmit={handleMcpAddSubmit}
      />

      {/* No-DCR / personal-access-token connect popup */}
      <McpTokenDialog
        open={!!tokenPromptRow}
        server={tokenPromptRow ? { id: tokenPromptRow.id, name: tokenPromptRow.name, url: tokenPromptRow.url } : null}
        onClose={() => setTokenPromptRow(null)}
        onSaved={() => void refreshMcpList()}
      />

      {/* Composer */}
      <div
        ref={composerRef}
        className={cn(
          simple ? 'px-3 pt-3 pb-4 sm:px-6' : 'px-4 pt-2.5 pb-3.5 sm:px-6',
        )}
      >
        <div className={cn(
          'rounded-2xl border border-surface-700 bg-surface-900/80 shadow-lg shadow-black/20 backdrop-blur transition-all focus-within:border-primary/50',
          simple ? 'mx-auto w-full max-w-3xl' : 'mx-auto w-full max-w-4xl',
        )}>
          {/* Textarea */}
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isRunning ? 'Agent is working…' : 'Ask Smoke Monkey to build, fix, or explain…'}
            disabled={isRunning}
            rows={1}
            className="box-border min-h-[44px] w-full max-h-[220px] resize-none bg-transparent px-3.5 pb-1 pt-3 text-sm leading-relaxed text-ink-primary placeholder:text-ink-muted focus:outline-none disabled:opacity-50 sm:px-4 sm:pt-3.5"
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = 'auto';
              target.style.height = Math.min(target.scrollHeight, 220) + 'px';
            }}
          />

          {/* Action bar — never wraps: the Send button stays on the same line and the
              model-name picker shrinks (min-w-0) + truncates instead of wrapping. */}
          <div className="flex min-w-0 flex-nowrap items-center gap-0.5 px-2 pb-2 pt-0.5">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,image/*,text/plain,application/zip"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                if (files.length > 0) {
                  setMessages((prev) => [...prev, ...files.map((file) => ({
                    id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    sessionId,
                    role: 'user' as const,
                    content: `[Attached: ${file.name}${file.type.startsWith('image/') ? ' (image)' : ''}]`,
                    tokensInput: 0,
                    tokensOutput: 0,
                    createdAt: new Date().toISOString(),
                  }))]);
                }
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex min-h-[36px] min-w-[36px] shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-ink-secondary transition-colors hover:bg-surface-800 hover:text-white sm:px-2.5"
              title="Attach files or images (drag & drop also works)"
            >
              <Paperclip className="h-4 w-4 shrink-0" />
              <span className="hidden md:inline">Attach</span>
            </button>

            <span className="hidden w-px self-stretch bg-surface-700/60 sm:block" />

            {onModelChange && providers.length > 0 && (
              <ModelPicker
                providers={displayProviders}
                provider={provider || 'ollama'}
                model={model || 'qwen3:8b'}
                modelInfo={omniModels.length > 0 ? omniHealth : undefined}
                onChange={onModelChange}
                compact
              />
            )}

              {/* Free-mode nudge — collapsed to icon at narrow panel widths */}
              {FREE_PROVIDERS.has(provider || '') === false && (
                <button
                  type="button"
                  onClick={() => onModelChange?.('omniroute', 'big-pickle')}
                  className="hidden shrink-0 items-center gap-1 rounded-lg bg-emerald-400/10 px-2 py-1.5 text-[11px] font-medium text-emerald-300 transition-colors hover:bg-emerald-400/20 md:inline-flex"
                  title="Switch to a free model (no API key needed)"
                >
                  <Zap className="h-3 w-3 shrink-0" />
                  <span className="hidden xl:inline">Free mode</span>
                </button>
              )}

            {/* API Keys / provider connection */}
            <ResponsivePopover
                sheetTitle="Connect a provider"
                className="p-3"
                trigger={
                <button
                  type="button"
                  className={cn(
                    'inline-flex min-h-[36px] shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors',
                    needsKey
                      ? 'text-warning hover:bg-warning/10'
                      : 'text-ink-muted hover:bg-surface-800 hover:text-white',
                    composerNarrow && !needsKey ? 'hidden' : 'lg:inline-flex',
                  )}
                  title={needsKey ? `Connect a provider — ${provider} needs a key` : 'Manage API keys / providers'}
                >
                  {needsKey ? (
                    <KeyRound className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <Key className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <span className="hidden xl:inline">{needsKey ? 'Connect provider' : 'API Keys'}</span>
                </button>
              }
            >
              <div className="w-full">
                <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                  {needsKey ? 'Connect a provider' : 'AI Providers'}
                </p>
                <p className="px-1 pb-2 text-[11px] text-ink-muted">
                  {needsKey
                    ? `Your current provider (${provider}) needs a key. Add one in Settings to keep using it.`
                    : 'Manage your provider API keys and connections.'}
                </p>
                <a href="/settings" className="inline-flex items-center gap-1.5 rounded-lg bg-surface-800 px-3 py-2 text-xs text-ink-primary hover:bg-surface-700 transition-colors">
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open Settings
                </a>
              </div>
            </ResponsivePopover>

            {/* MCP quick-add */}
            <ResponsivePopover
              sheetTitle="MCP Servers"
              className="p-3"
              trigger={
                <button
                  type="button"
                  className={cn(
                    'inline-flex min-h-[36px] shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors',
                    'text-ink-muted hover:bg-surface-800 hover:text-white',
                    composerNarrow ? 'hidden' : 'lg:inline-flex',
                  )}
                  title="MCP Servers — connect external tool providers"
                >
                  <Plug className="h-3.5 w-3.5 shrink-0" />
                  <span className="hidden xl:inline">MCP</span>
                  {mcpServers.length > 0 && (
                    <span className="hidden rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] text-[#c4b5fd] xl:inline">
                      {mcpServers.filter(s => s.enabled).length}
                    </span>
                  )}
                </button>
              }
            >
              <div className="w-full">
                <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                  MCP Servers
                </p>
                <p className="px-1 pb-2 text-[11px] text-ink-muted">
                  {mcpServers.filter((s) => s.enabled).length} enabled · External tool providers (max 3 active at once).
                </p>
                {(() => {
                  const enabled = mcpServers.filter((s) => s.enabled);
                  const available = mcpServers.filter((s) => !s.enabled);
                  if (mcpServers.length === 0) {
                    return <p className="px-1 pb-2 text-xs text-ink-muted/60">No servers configured. Add one on the MCP page.</p>;
                  }
                  return (
                    <div className="max-h-[42vh] space-y-2.5 overflow-y-auto pr-0.5">
                      {enabled.length > 0 && (
                        <div className="space-y-1">
                          <p className="flex items-center gap-1.5 px-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400/80">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
                            Active · {enabled.length}
                          </p>
                          {enabled.map((s) => (
                            <a
                              key={s.id}
                              href={`/mcp?server=${encodeURIComponent(s.id)}`}
                              className="flex items-center gap-2.5 rounded-lg bg-surface-800/80 px-2.5 py-1.5 ring-1 ring-inset ring-surface-700/50 transition-colors hover:bg-surface-700"
                              title="Manage this server on the MCP page"
                            >
                              <McpServerIcon name={s.name} icon={s.icon} />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-xs text-white">{s.name}</span>
                                {s.description && (
                                  <span className="block truncate text-[10px] text-ink-muted">{s.description}</span>
                                )}
                              </span>
                              <span className="shrink-0 rounded-full bg-emerald-400/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-400">
                                On
                              </span>
                            </a>
                          ))}
                        </div>
                      )}
                      {available.length > 0 && (
                        <div className="space-y-1">
                          <p className="px-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted/70">
                            Available · {available.length}
                          </p>
                          {available.map((s) => (
                            <a
                              key={s.id}
                              href={`/mcp?server=${encodeURIComponent(s.id)}`}
                              className="flex items-center gap-2.5 rounded-lg bg-surface-800/60 px-2.5 py-1.5 transition-colors hover:bg-surface-700"
                              title="Enable this server on the MCP page"
                            >
                              <McpServerIcon name={s.name} icon={s.icon} dim />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-xs text-white/90">{s.name}</span>
                                {s.description && (
                                  <span className="block truncate text-[10px] text-ink-muted">{s.description}</span>
                                )}
                              </span>
                              <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary/90">
                                Enable
                              </span>
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}
                <a href="/mcp" className="inline-flex items-center gap-1.5 rounded-lg bg-surface-800 px-3 py-2 text-xs text-ink-primary hover:bg-surface-700 transition-colors">
                  <ExternalLink className="h-3.5 w-3.5" />
                  Manage MCP Servers
                </a>
              </div>
            </ResponsivePopover>

            <span className="hidden flex-1 sm:block" />

            {/* Compact context meter — icon + numbers + bar in one aligned pill */}
            <div
              className={cn(
                'flex min-w-0 shrink-0 items-center gap-1.5 rounded-full border border-surface-700/60 bg-surface-850/50 py-1 pl-2 pr-1.5',
                composerNarrow ? 'hidden md:flex' : 'sm:flex',
              )}
              title={`Estimated context: ${tokenBudget.used.toLocaleString()} / ${tokenBudget.limit.toLocaleString()} tokens · compacting starts at ${tokenBudget.compactionAt.toLocaleString()} tokens (70%)`}
            >
              <Brain className="h-3 w-3 shrink-0 text-ink-muted" />
              <span className="whitespace-nowrap text-[10px] font-medium tabular-nums leading-none">
                <span className={tokenStateClass}>{formatTokens(tokenBudget.used)}</span>
                <span className="hidden pl-1 text-ink-muted/50 sm:inline">/ {formatTokens(tokenBudget.limit)}</span>
              </span>
              <ContextUsageBar
                compact
                used={tokenBudget.used}
                limit={tokenBudget.limit}
                compactionAt={tokenBudget.compactionAt}
                state={tokenBudget.state}
              />
            </div>

            {isRunning ? (
              <button
                type="button"
                onClick={handleInterrupt}
                className="inline-flex min-h-[36px] min-w-[36px] shrink-0 items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-surface-800 hover:text-red-200"
                title="Stop the agent"
              >
                <Square className="h-4 w-4 shrink-0" />
                <span className="hidden sm:inline">Stop</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={!input.trim()}
                className="ml-auto flex h-9 w-9 min-h-[36px] min-w-[36px] shrink-0 items-center justify-center rounded-xl bg-primary text-white shadow-lg shadow-primary/25 transition-all hover:bg-primary-hover active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                title="Send"
              >
                <Send className="h-4 w-4" />
              </button>
            )}
          </div>
          {/* End of rounded composer box */}
        </div>
      </div>
        </div>
      </div>
    </div>
  );
}