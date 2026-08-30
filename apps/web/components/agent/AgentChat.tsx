'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Send, Square, Loader2, Check, X, Copy, ExternalLink, ChevronDown, ChevronRight,
  MessageSquare, Bot, Wrench, FileText, Code2, History, Plus, KeyRound,
  Search as SearchIcon, Terminal as TerminalIcon, PenLine, FilePlus2, Trash2,
  FlaskConical, GitBranch, FolderTree, ListChecks, AlertCircle, Sparkles, Container,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import type { AgentMessage, AgentEvent, AgentSession } from '../../lib/agent-api';
import { agentApi } from '../../lib/agent-api';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import type { ModelProvider, UserKeyDto } from '@rag/contracts';
import { ModelPicker } from '../chat/ModelPicker';
import { AskUserDialog } from './AskUserDialog';
import { InlineDiff } from './InlineDiff';
import { AnsiText } from '../../lib/ansi';

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
}

/** Providers that require a user-uploaded API key (no env var fallback in production). */
const KEY_REQUIRED_PROVIDERS = new Set(['openrouter', 'nvidia', 'openai', 'xai', 'gemini', 'opencode']);

// ── Tool metadata: semantic identity + activity grouping ──────────────────

type ToolFamily = 'inspect' | 'edit' | 'run' | 'verify' | 'git' | 'plan' | 'ask';

interface ToolMeta {
  label: string;
  icon: LucideIcon;
  family: ToolFamily;
  familyLabel: string;
}

const TOOL_META: Record<string, ToolMeta> = {
  search_code: { label: 'Search', icon: SearchIcon, family: 'inspect', familyLabel: 'Inspecting' },
  grep: { label: 'Search', icon: SearchIcon, family: 'inspect', familyLabel: 'Inspecting' },
  glob: { label: 'Search', icon: SearchIcon, family: 'inspect', familyLabel: 'Inspecting' },
  find_symbol: { label: 'Find', icon: SearchIcon, family: 'inspect', familyLabel: 'Inspecting' },
  read_file: { label: 'Read', icon: FileText, family: 'inspect', familyLabel: 'Inspecting' },
  list_directory: { label: 'List', icon: FolderTree, family: 'inspect', familyLabel: 'Inspecting' },
  docker_list: { label: 'Containers', icon: Container, family: 'inspect', familyLabel: 'Inspecting' },
  edit_file: { label: 'Edit', icon: PenLine, family: 'edit', familyLabel: 'Editing' },
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
  todo_write: { label: 'Plan', icon: ListChecks, family: 'plan', familyLabel: 'Planning' },
  ask_user: { label: 'Ask', icon: MessageSquare, family: 'ask', familyLabel: 'Asking' },
};

const FALLBACK_META: ToolMeta = { label: 'Tool', icon: Wrench, family: 'run', familyLabel: 'Running' };

function metaFor(name: string): ToolMeta {
  return TOOL_META[name] || FALLBACK_META;
}

// ── Shared helpers ───────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
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

/**
 * Premium markdown body. Rely on the shared `.md-body` token styles (spacing,
 * lists, headings, inline code) instead of stacked prose overrides, so
 * assistant answers read like a real chat — not bordered cards.
 */
function MarkdownRenderer({ content, onFileSelect: _onFileSelect }: { content: string; onFileSelect?: (path: string) => void }) {
  return (
    <div className="md-body min-w-0 text-[13.5px]">
      <ReactMarkdown
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
        }}
      >
        {content}
      </ReactMarkdown>
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
    t = String(first('path', 'filePath', 'relativePath') ?? '');
  }
  if (!t) return '';
  return t.replace(/\s+/g, ' ').trim();
}

function toolRenderStatus(status: string): 'active' | 'ok' | 'err' | 'blocked' {
  if (status === 'running' || status === 'queued') return 'active';
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'err';
  return 'blocked';
}

/** Extract a fenced ```diff …``` block from tool result text, if present. */
const FENCES = /```diff\s*\n([\s\S]*?)```/;
function extractDiffBlock(text: string): string | null {
  if (!text) return null;
  const m = FENCES.exec(text);
  return m ? m[1] : null;
}

const EDIT_TOOLS = new Set(['edit_file', 'replace_lines', 'apply_patch', 'write_file', 'delete_file']);

interface TcShape {
  id: string;
  toolName: string;
  arguments: unknown;
  status: string;
  output?: string;
  result?: unknown;
  error?: string;
}

/** One lightweight agent action; click to reveal arguments/output. */
function ToolRow({ tc, startTime, onFileSelect }: { tc: TcShape; startTime?: number; onFileSelect?: (path: string) => void }) {
  const meta = metaFor(tc.toolName);
  const Icon = meta.icon;
  const status = toolRenderStatus(tc.status);
  const [expanded, setExpanded] = useState(
    (tc.toolName === 'run_command' || tc.toolName === 'run_test') && (tc.status === 'running' || tc.status === 'queued'),
  );
  const outputRef = useRef<HTMLPreElement>(null);

  // Keep the tail of a streaming command visible as it grows.
  useEffect(() => {
    if ((tc.toolName === 'run_command' || tc.toolName === 'run_test') && tc.status === 'running' && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [tc.output, tc.status, tc.toolName]);

  const target = toolTarget(tc);
  const command = (tc.toolName === 'run_command' || tc.toolName === 'run_test' || tc.toolName === 'ssh_run' || tc.toolName === 'docker_exec')
    ? (typeof tc.arguments === 'object' && tc.arguments !== null ? (tc.arguments as Record<string, unknown>).command : undefined)
    : undefined;
  const filePath = typeof tc.arguments === 'object' && tc.arguments !== null
    ? (tc.arguments as Record<string, unknown>).path || (tc.arguments as Record<string, unknown>).filePath
    : undefined;
  const argsStr = typeof tc.arguments === 'object' && tc.arguments !== null ? JSON.stringify(tc.arguments, null, 2) : String(tc.arguments || '');
  const duration = startTime && status !== 'active' ? formatDuration(Date.now() - startTime) : null;
  const outputDiff = EDIT_TOOLS.has(tc.toolName) ? extractDiffBlock(tc.output || '') : null;

  return (
    <div className="ml-6">
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className={cn(
          'group flex w-full items-center gap-1.5 rounded-md px-1.5 py-[5px] pr-2 text-left transition-colors',
          status === 'active' && 'bg-white/[0.02]',
          status === 'err' ? 'hover:bg-red-500/[0.06]' : 'hover:bg-white/[0.035]',
        )}
      >
        <span
          className={cn(
            'shrink-0',
            status === 'active' ? 'text-blue-400' : status === 'err' ? 'text-red-400' : status === 'blocked' ? 'text-yellow-400' : 'text-ink-muted/60',
          )}
        >
          {status === 'active' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Icon className="h-3 w-3" />}
        </span>

        <span className="shrink-0 text-[11px] font-medium text-foreground/70">{meta.label}</span>

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
        {duration && <span className="shrink-0 text-[9px] text-ink-muted/40">{duration}</span>}

        <span className="shrink-0">
          {expanded ? <ChevronDown className="h-3 w-3 text-ink-muted/40" /> : <ChevronRight className="h-3 w-3 text-ink-muted/40" />}
        </span>
      </button>

      {expanded && (
        <div className="mt-1 mb-1.5 ml-3.5 space-y-1.5 rounded-lg border border-border/40 bg-surface-900/40 px-2.5 py-2 text-[11px]">
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
                      ? 'text-emerald-200/70 bg-black/60'
                      : 'text-ink-secondary/90 bg-black/30',
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
          {typeof filePath === 'string' && onFileSelect && status === 'ok' && (
            <button
              onClick={() => onFileSelect(filePath)}
              className="flex items-center gap-1 text-[10px] text-primary hover:text-primary/80 transition-colors"
            >
              <ExternalLink className="h-2.5 w-2.5" /> Open in editor
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Small phase label that groups related actions ("● Inspecting"). */
function ActivityHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="ml-6 py-0.5 flex items-center gap-1.5">
      <span className="h-1 w-1 rounded-full bg-primary/60" />
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted/70">{label}</span>
      {count > 1 && <span className="text-[9px] tabular-nums text-ink-muted/40">{count}</span>}
    </div>
  );
}

// ── Todo list ────────────────────────────────────────────────────────────

function TodoList({ todos }: { todos: Array<{ content: string; status: string; priority: string }> }) {
  const [expanded, setExpanded] = useState(true);
  const completed = todos.filter(t => t.status === 'completed').length;
  const inProgress = todos.filter(t => t.status === 'in_progress').length;

  return (
    <div className="sticky top-0 z-10 ml-6 mb-1 rounded-lg bg-background/90 backdrop-blur-sm px-1.5 py-1">
      <button onClick={() => setExpanded(!expanded)} className="flex w-full items-center gap-1.5 py-1 text-left transition-colors hover:text-foreground">
        <ListChecks className="h-3 w-3 shrink-0 text-ink-muted/70" />
        <span className="text-[11px] font-medium text-foreground/75">Task list</span>
        <span className="text-[10px] text-ink-muted/60">
          {completed}/{todos.length} done{inProgress > 0 && ` · ${inProgress} active`}
        </span>
        {expanded ? <ChevronDown className="ml-auto h-3 w-3 text-ink-muted/40" /> : <ChevronRight className="ml-auto h-3 w-3 text-ink-muted/40" />}
      </button>
      {expanded && (
        <div className="mb-1 space-y-0.5 pl-4">
          {todos.map((t, i) => {
            const done = t.status === 'completed';
            const active = t.status === 'in_progress';
            const cancelled = t.status === 'cancelled';
            return (
              <div key={i} className={`flex items-center gap-2 py-0.5 text-[11px] ${cancelled ? 'opacity-40' : ''}`}>
                <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${done ? 'border-green-500/50 bg-green-500/15 text-green-400' : active ? 'border-blue-500/50 bg-blue-500/15 text-blue-400' : 'border-border text-transparent'}`}>
                  {done ? <Check className="h-2.5 w-2.5" /> : active ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : null}
                </span>
                <span className={`min-w-0 flex-1 truncate ${done ? 'line-through text-ink-muted/50' : cancelled ? 'line-through text-ink-muted/40' : 'text-ink-secondary'}`}>
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

// ── Thinking + agent state indicators ────────────────────────────────────

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 py-0.5 text-xs text-ink-muted/60">
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
function CompactingBanner() {
  return (
    <div className="ml-6 flex items-center gap-2 py-1 text-[11px] text-violet-300/70">
      <Loader2 className="h-3 w-3 animate-spin" />
      <span>Condensing older conversation into a summary…</span>
    </div>
  );
}

/** Collapsed notice rendered once after a compaction completes. */
function CompactedNotice({ tokensSaved }: { tokensSaved: number }) {
  return (
    <div className="ml-6 flex items-center gap-2 py-0.5 text-[11px] text-ink-muted/60">
      <History className="h-3 w-3 shrink-0 text-violet-300/60" />
      <span>Context compacted · saved ~{formatTokenCount(tokensSaved)} tokens</span>
    </div>
  );
}

// ── Status line ──────────────────────────────────────────────────────────

function AgentStatusIndicator({ stepCount, duration, isRunning, streamingText, messages }: {
  stepCount: number;
  duration: number;
  isRunning: boolean;
  streamingText?: string;
  messages: AgentMessage[];
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

export function AgentChat({ sessionId, workspacePath, isRunning, onStatusChange, onFileSelect, model, provider, onModelChange, injectedPrompt, sessions = [], activeSessionId, onSelectSession, onNewSession, remoteProfileId }: Props) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [stepCount, setStepCount] = useState(0);
  const [duration, setDuration] = useState(0);
  const [todos, setTodos] = useState<Array<{ content: string; status: string; priority: string }> | null>(null);
  const [pendingPermission, setPendingPermission] = useState<{ toolCallId: string; toolName: string; args: unknown } | null>(null);
  const [pendingAskUser, setPendingAskUser] = useState<{ toolCallId: string; question: string; options: Array<{ label: string; description: string }>; multiple: boolean } | null>(null);
  const [isUserScrolled, setIsUserScrolled] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [lastCompaction, setLastCompaction] = useState<{ tokensBefore: number; tokensAfter: number; tokensSaved: number; messagesCompacted: number } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const durationInterval = useRef<NodeJS.Timeout | null>(null);
  const agentStartTimeRef = useRef<number>(0);
  const toolStartTimes = useRef<Map<string, number>>(new Map());
  const handleEventRef = useRef<(event: AgentEvent) => void>(() => {});
  const abortRef = useRef<AbortController | null>(null);

  // ── Model picker + key indicator ───────────────────────────────────────
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [savedKeys, setSavedKeys] = useState<UserKeyDto[]>([]);

  useEffect(() => {
    agentApi.getModels().then((data: any) => {
      if (data?.providers) setProviders(data.providers);
    }).catch(() => {});
    api.listKeys().then((data) => {
      if (data?.keys) setSavedKeys(data.keys);
    }).catch(() => {});
  }, []);

  const hasKeyForCurrentProvider = useMemo(() => {
    if (!provider) return true;
    return savedKeys.some((k) => k.provider === provider && k.status === 'ok');
  }, [provider, savedKeys]);

  const needsKey = KEY_REQUIRED_PROVIDERS.has(provider || '') && !hasKeyForCurrentProvider;

  useEffect(() => {
    loadMessages();
  }, [sessionId]);

  useEffect(() => {
    if (injectedPrompt?.text) {
      setInput(injectedPrompt.text);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [injectedPrompt?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, [sessionId]);

  useEffect(() => {
    if (!isUserScrolled) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streamingText, isUserScrolled]);

  useEffect(() => {
    if (isRunning && agentStartTimeRef.current > 0) {
      durationInterval.current = setInterval(() => {
        setDuration(Math.floor((Date.now() - agentStartTimeRef.current) / 1000));
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
  }, []);

  async function loadMessages() {
    try {
      const msgs = await agentApi.getMessages(sessionId);
      setMessages(msgs);
    } catch { /* ignore */ }
  }

  const handleEvent = useCallback((event: AgentEvent) => {
    const { type, data } = event;

    switch (type) {
      case 'ping':
        break; // keepalive — ignore
      case 'run.started':
        agentStartTimeRef.current = Date.now();
        setStepCount(0);
        setDuration(0);
        setIsUserScrolled(false);
        setIsThinking(true);
        setIsCompacting(false);
        setLastCompaction(null);
        break;

      case 'compaction.started':
        setIsCompacting(true);
        break;

      case 'compaction.completed':
        setIsCompacting(false);
        setLastCompaction({
          tokensBefore: data.tokensBefore as number,
          tokensAfter: data.tokensAfter as number,
          tokensSaved: data.tokensSaved as number,
          messagesCompacted: data.messagesCompacted as number,
        });
        break;

      case 'text.delta':
        setIsThinking(false);
        setStreamingText((prev) => prev + (data.delta as string));
        break;

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

        if (data.content || toolCalls) {
          setMessages((prev) => {
            const next = [...prev];
            // Check if tool events already created messages with these tool call IDs
            if (toolCalls && toolCalls.length > 0) {
              const tcIds = new Set(toolCalls.map((tc) => tc.id));
              // Find an existing message that contains any of these tool call IDs
              const existingIdx = next.findIndex((m) =>
                m.role === 'assistant' && m.toolCalls?.some((tc) => tcIds.has(tc.id)),
              );
              if (existingIdx !== -1) {
                // Merge: update content and fill in any missing tool calls
                const existing = next[existingIdx];
                const mergedToolCalls = [...(existing.toolCalls || [])];
                for (const tc of toolCalls) {
                  if (!mergedToolCalls.find((e) => e.id === tc.id)) {
                    mergedToolCalls.push(tc);
                  }
                }
                next[existingIdx] = {
                  ...existing,
                  content: (data.content as string) || existing.content,
                  toolCalls: mergedToolCalls,
                };
                return next;
              }
            }
            // No existing message — create new one
            next.push({
              id: data.messageId as string || `msg-${Date.now()}`,
              sessionId,
              role: 'assistant',
              content: (data.content as string) || '',
              toolCalls: toolCalls || null,
              tokensInput: 0,
              tokensOutput: 0,
              createdAt: new Date().toISOString(),
            });
            return next;
          });
        }
        setStreamingText('');
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

      case 'tool.completed':
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

      case 'todo.updated':
        setTodos(Array.isArray(data.todos) ? data.todos as Array<{ content: string; status: string; priority: string }> : null);
        break;

      case 'step.started':
        setStepCount(data.step as number);
        setIsThinking(true);
        break;

      case 'llm.thinking':
        setIsThinking(true);
        break;

      case 'permission.required':
        setPendingPermission({
          toolCallId: data.toolCallId as string,
          toolName: data.toolName as string,
          args: data.args,
        });
        break;

      case 'ask_user.required':
        setPendingAskUser({
          toolCallId: data.toolCallId as string,
          question: data.question as string,
          options: (data.options as Array<{ label: string; description: string }>) || [],
          multiple: Boolean(data.multiple),
        });
        break;

      case 'run.completed':
      case 'run.interrupted':
      case 'run.failed':
        if (abortRef.current) {
          abortRef.current.abort();
          abortRef.current = null;
        }
        onStatusChange(false);
        setStreamingText('');
        setIsThinking(false);
        setIsCompacting(false);
        setPendingAskUser(null);
        setPendingPermission(null);
        // Reload messages to get final persisted state with toolCalls
        loadMessages();
        agentStartTimeRef.current = 0;
        break;
    }
  }, [sessionId, onStatusChange]);

  useEffect(() => {
    handleEventRef.current = handleEvent;
  }, [handleEvent]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isRunning) return;

    setInput('');
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
    setIsUserScrolled(false);

    const controller = new AbortController();
    abortRef.current = controller;

    onStatusChange(true);

    try {
      const eventPromise = (async () => {
        for await (const event of agentApi.streamEvents(sessionId, controller.signal)) {
          handleEventRef.current(event);
        }
      })();

      await new Promise((r) => setTimeout(r, 50));
      await agentApi.runAgent(sessionId, text, { workspacePath, model, provider, remoteProfileId });
      await eventPromise;
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        // "Load failed" means the SSE stream dropped (network/proxy timeout)
        const isLoadFailed = err instanceof TypeError && err.message === 'Load failed';
        const msg = isLoadFailed
          ? 'Connection to agent lost. The agent may still be running — try refreshing.'
          : `Error: ${err instanceof Error ? err.message : 'Failed to start agent'}`;
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
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [input, isRunning, sessionId, workspacePath, model, provider, onStatusChange, remoteProfileId]);

  const handleInterrupt = useCallback(async () => {
    try {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
      await agentApi.interrupt(sessionId);
      onStatusChange(false);
    } catch { /* ignore */ }
  }, [sessionId, onStatusChange]);

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
    let lastRenderedFamily: ToolFamily | null = null;
    let afterContent = false;

    const pushActivity = (meta: ToolMeta, calls: TcShape[]) => {
      if (afterContent || lastRenderedFamily !== meta.family) {
        const headerLabel = FAMILY_LABELS[meta.family];
        elements.push(<ActivityHeader key={`h-${calls[0].id}`} label={headerLabel} count={calls.length} />);
        lastRenderedFamily = meta.family;
        afterContent = false;
      }
      calls.forEach((tc, i) => {
        const startTime = toolStartTimes.current.get(tc.id);
        elements.push(
          <ToolRow key={`tc-${tc.id}-${i}`} tc={tc} startTime={startTime} onFileSelect={onFileSelect} />,
        );
      });
    };

    // Live compaction progress + last-result notice
    if (isCompacting) {
      elements.push(<CompactingBanner key="compacting-live" />);
      afterContent = true;
    } else if (lastCompaction) {
      elements.push(<CompactedNotice key="compacted-notice" tokensSaved={lastCompaction.tokensSaved} />);
      afterContent = true;
    }

    // Persistent todo list — shown at the top while the agent works
    if (todos && todos.length > 0) {
      elements.push(<TodoList key="todo-list" todos={todos} />);
      afterContent = true;
    }

    messages.forEach((msg) => {
      if (msg.role === 'user') {
        afterContent = true;
        lastRenderedFamily = null;
        elements.push(
          <div key={msg.id} className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl rounded-br-md bg-surface-800/90 px-3.5 py-2 text-sm text-ink-primary border border-border/40">
              <div className="whitespace-pre-wrap break-words leading-relaxed">{msg.content}</div>
            </div>
          </div>
        );
      } else if (msg.role === 'system') {
        // Engine/agent notices (nudges, errors) — subtle inline status, not a
        // yellow warning box. Errors get a red tint, everything else stays calm.
        const isError = /error|failed|aborted|stopping/i.test(msg.content);
        afterContent = true;
        lastRenderedFamily = null;
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
              <Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-primary/50" />
            )}
            <div className="min-w-0 whitespace-pre-wrap break-words">{msg.content}</div>
          </div>
        );
      } else if (msg.role === 'tool') {
        // Tool messages are handled by toolCalls on assistant messages, skip
        afterContent = false;
      } else if (msg.role === 'assistant') {
        // Render content (the conversation — PRIMARY)
        if (msg.content) {
          afterContent = true;
          lastRenderedFamily = null;
          elements.push(
            <div key={msg.id}>
              <div className="flex items-start gap-2">
                <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Bot className="h-3 w-3" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="mb-0.5 text-[11px] font-medium text-ink-muted/80">Smoke Monkey</div>
                  <MarkdownRenderer content={msg.content} onFileSelect={onFileSelect} />
                </div>
              </div>
            </div>
          );
        }
        // Render tool calls as grouped compact activity rows
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          // group consecutive calls into contiguous family runs
          let run: TcShape[] = [];
          let runMeta = metaFor(msg.toolCalls[0].toolName);
          const flushRun = () => {
            if (run.length > 0) pushActivity(runMeta, run);
            run = [];
          };
          for (const tc of msg.toolCalls) {
            const m = metaFor(tc.toolName);
            if (run.length > 0 && (m.family !== runMeta.family || m.familyLabel !== runMeta.familyLabel)) {
              flushRun();
            }
            runMeta = m;
            run.push(tc);
          }
          flushRun();
        }
      }
    });

    // Render streaming text (PRIMARY)
    if (streamingText) {
      afterContent = true;
      lastRenderedFamily = null;
      elements.push(
        <div key="streaming">
          <div className="flex items-start gap-2">
            <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Bot className="h-3 w-3" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="mb-0.5 text-[11px] font-medium text-ink-muted/80">Smoke Monkey</div>
              <MarkdownRenderer content={streamingText} onFileSelect={onFileSelect} />
              <span className="ml-0.5 inline-block h-3.5 w-1.5 bg-foreground/50 align-text-bottom animate-pulse-soft" />
            </div>
          </div>
        </div>
      );
    }

    // Show thinking indicator when running but no text/tools yet
    if (isRunning && isThinking && !streamingText) {
      const lastMsg = messages[messages.length - 1];
      const hasLiveTools = lastMsg?.role === 'assistant' && lastMsg.toolCalls?.some((tc) => tc.status === 'running');
      if (!hasLiveTools) {
        elements.push(
          <div key="thinking">
            <div className="flex items-start gap-2 px-1 py-0.5">
              <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Bot className="h-3 w-3" />
              </span>
              <ThinkingIndicator />
            </div>
          </div>
        );
      }
    }

    return elements;
  };

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Chat header */}
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

      {/* Status line */}
      <AgentStatusIndicator
        stepCount={stepCount}
        duration={duration}
        isRunning={isRunning}
        streamingText={streamingText}
        messages={messages}
      />

      {/* Toolbar */}
      {!isRunning && messages.length > 0 && (
        <div className="flex items-center justify-end px-4 py-1">
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
        </div>
      )}

      {/* Messages area */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-1.5 scrollbar-thin"
      >
        {messages.length === 0 && !streamingText && !isRunning && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
              <Sparkles className="h-4 w-4 text-primary" />
            </div>
            <h3 className="mt-3 text-sm font-medium text-foreground/85">Smoke Monkey</h3>
            <p className="mt-1 max-w-xs text-xs text-ink-muted/70 leading-relaxed">
              Build, debug, and modify your codebase.
            </p>
            <div className="mt-4 grid w-full max-w-sm grid-cols-2 gap-1.5">
              {[
                'Fix the failing tests',
                'Explain this code',
                'Add a feature',
                'Find a bug',
              ].map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => { setInput(prompt); inputRef.current?.focus(); }}
                  className="rounded-lg border border-border/50 bg-surface-900/60 px-2.5 py-2 text-left text-[11px] text-ink-muted transition-colors hover:border-primary/30 hover:text-foreground"
                >
                  {prompt}
                </button>
              ))}
            </div>
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
              className="mt-4 flex items-center gap-1.5 rounded-md border border-border/40 px-3 py-1.5 text-[11px] text-ink-muted transition-colors hover:text-foreground"
            >
              <Code2 className="h-3 w-3" /> Open in Smoke Monkey IDE
            </button>
          </div>
        )}

        {renderConversation()}

        <div ref={messagesEndRef} />
      </div>

      {/* Permission request */}
      {pendingPermission && (
        <div className="mx-4 mb-2 rounded-lg border border-yellow-500/25 bg-yellow-500/[0.06] px-3 py-2">
          <div className="flex items-center gap-2 mb-1.5">
            <AlertCircle className="h-3.5 w-3.5 text-yellow-500/80" />
            <p className="text-xs font-medium">
              Allow <span className="font-mono text-yellow-500/90">{pendingPermission.toolName}</span>?
            </p>
          </div>
          <pre className="max-h-16 overflow-y-auto mb-2 rounded bg-black/30 p-2 text-[11px] text-ink-muted font-mono">
            {JSON.stringify(pendingPermission.args, null, 2).slice(0, 300)}
          </pre>
          <div className="flex gap-1.5">
            <button onClick={async () => {
              if (pendingPermission) {
                await agentApi.resolvePermission(pendingPermission.toolCallId, 'allow');
                setPendingPermission(null);
              }
            }}
              className="flex items-center gap-1 rounded-md bg-green-600 px-2.5 py-1 text-[11px] text-white hover:bg-green-700 transition-colors">
              <Check className="h-3 w-3" /> Allow
            </button>
            <button onClick={async () => {
              if (pendingPermission) {
                await agentApi.resolvePermission(pendingPermission.toolCallId, 'deny');
                setPendingPermission(null);
              }
            }}
              className="flex items-center gap-1 rounded-md bg-red-600 px-2.5 py-1 text-[11px] text-white hover:bg-red-700 transition-colors">
              <X className="h-3 w-3" /> Deny
            </button>
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
          }
        }}
        onDismiss={() => setPendingAskUser(null)}
      />

      {/* Composer */}
      <div className="border-t border-border/40">
        <div className="p-2.5">
          <div className="mb-1.5 flex h-6 items-center gap-1.5 px-0.5">
            {providers.length > 0 && onModelChange && (
              <ModelPicker
                providers={providers}
                provider={provider || 'ollama'}
                model={model || 'qwen3:8b'}
                onChange={onModelChange}
                compact
              />
            )}
            <div className="ml-auto flex items-center">
              {needsKey && (
                <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">
                  <KeyRound className="h-3 w-3" />
                  Key required
                </span>
              )}
            </div>
          </div>
          <div className="flex items-end gap-1.5">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isRunning ? 'Agent is working…' : 'Ask Smoke Monkey…'}
              disabled={isRunning}
              rows={1}
              className="flex-1 max-h-[120px] resize-none rounded-xl border border-border/50 bg-surface-900/70 px-3 py-2 text-sm placeholder:text-ink-muted/40 transition-colors focus:border-primary/40 focus:outline-none disabled:opacity-50"
              style={{ height: 'auto', minHeight: '38px' }}
              onInput={(e) => {
                const target = e.target as HTMLTextAreaElement;
                target.style.height = 'auto';
                target.style.height = Math.min(target.scrollHeight, 120) + 'px';
              }}
            />
            {isRunning ? (
              <button onClick={handleInterrupt} title="Stop"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-red-600/90 text-white transition-colors hover:bg-red-700">
                <Square className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button onClick={handleSend} disabled={!input.trim()} title="Send"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground transition-all hover:bg-primary-hover disabled:opacity-30">
                <Send className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="mt-1.5 px-1 text-[10px] text-ink-muted/35">
            Enter to send · Shift+Enter for new line
          </div>
        </div>
      </div>
    </div>
  );
}