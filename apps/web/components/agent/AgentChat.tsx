'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Send, Square, Loader2, Check, X, AlertTriangle, Copy, ExternalLink, ChevronDown, ChevronRight, MessageSquare, Bot, Wrench, FileText, Loader, Code2, History, Plus, KeyRound } from 'lucide-react';
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
}

/** Providers that require a user-uploaded API key (no env var fallback in production). */
const KEY_REQUIRED_PROVIDERS = new Set(['openrouter', 'nvidia', 'openai', 'xai', 'gemini']);

// Timeline event types for inline rendering
const TOOL_ICONS: Record<string, typeof Wrench> = {
  run_command: Wrench,
  run_test: Wrench,
  read_file: FileText,
  write_file: FileText,
  edit_file: FileText,
  apply_patch: FileText,
  list_directory: FileText,
  glob: FileText,
  grep: FileText,
};

const TOOL_LABELS: Record<string, string> = {
  read_file: 'Reading',
  write_file: 'Writing',
  edit_file: 'Editing',
  apply_patch: 'Patching',
  delete_file: 'Deleting',
  list_directory: 'Listing',
  run_command: 'Running',
  run_test: 'Testing',
  glob: 'Searching',
  grep: 'Searching',
  find_symbol: 'Finding',
  search_code: 'Searching',
  git_status: 'Git status',
  git_diff: 'Git diff',
  git_log: 'Git log',
  todo_write: 'Updating todos',
  ask_user: 'Asking',
};

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
      className="p-1 rounded hover:bg-muted/80 text-ink-muted hover:text-foreground transition-colors"
      title="Copy"
    >
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function MarkdownRenderer({ content, onFileSelect }: { content: string; onFileSelect?: (path: string) => void }) {
  return (
    <div className="prose prose-invert prose-sm max-w-none
      [&>pre]:rounded-lg [&>pre]:border [&>pre]:border-border [&>pre]:bg-background [&>pre]:p-0 [&>pre]:my-3
      [&_code]:text-[13px] [&_code]:font-mono
      [&_pre_code]:block [&_pre_code]:p-4 [&_pre_code]:overflow-x-auto
      [&_pre_code]:!bg-transparent [&_pre_code]:!text-foreground
      [&_p]:my-1.5 [&_p]:leading-relaxed
      [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5
      [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:mt-4 [&_h1]:mb-2
      [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1.5
      [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1
      [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-ink-muted
      [&_table]:text-xs [&_table]:border-collapse [&_table]:w-full
      [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:bg-muted/50
      [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1
      [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2
      [&_hr]:my-4 [&_hr]:border-border
    ">
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
              return (
                <div className="relative group">
                  <div className="flex items-center justify-between px-3 py-1 border-b border-border bg-muted/30 rounded-t-lg">
                    <span className="text-[10px] text-ink-muted font-mono">{lang || 'code'}</span>
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <CopyButton text={codeText} />
                    </div>
                  </div>
                  <pre className="!bg-background !p-4 !overflow-x-auto !rounded-t-none">{children}</pre>
                </div>
              );
            }
            return <pre className="!bg-background !p-4 !overflow-x-auto">{children}</pre>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

// ── Inline tool call card ────────────────────────────────────────────────

function InlineToolCard({ tc, startTime, onFileSelect }: { tc: { id: string; toolName: string; arguments: unknown; status: string; output?: string; result?: unknown; error?: string }; startTime?: number; onFileSelect?: (path: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const label = TOOL_LABELS[tc.toolName] || tc.toolName;
  const Icon = TOOL_ICONS[tc.toolName] || Wrench;

  const filePath = typeof tc.arguments === 'object' && tc.arguments !== null
    ? (tc.arguments as Record<string, unknown>).path || (tc.arguments as Record<string, unknown>).filePath
    : undefined;

  const command = typeof tc.arguments === 'object' && tc.arguments !== null
    ? (tc.arguments as Record<string, unknown>).command
    : undefined;

  const argsStr = typeof tc.arguments === 'object' ? JSON.stringify(tc.arguments, null, 2) : String(tc.arguments || '');

  return (
    <div className="ml-6 rounded-lg border border-border/50 bg-surface/50 overflow-hidden text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-surface-hover transition-colors text-left"
      >
        {tc.status === 'running' || tc.status === 'queued' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400 shrink-0" />
        ) : tc.status === 'completed' ? (
          <span className="h-3.5 w-3.5 shrink-0 text-green-500 flex items-center justify-center">✓</span>
        ) : tc.status === 'failed' ? (
          <span className="h-3.5 w-3.5 shrink-0 text-red-500 flex items-center justify-center">✕</span>
        ) : (
          <Icon className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
        )}

        <span className="text-foreground/80 font-medium">{label}</span>

        {typeof command === 'string' && (
          <code className="text-ink-muted font-mono truncate max-w-[250px] bg-background/50 px-1.5 py-0.5 rounded">
            $ {command}
          </code>
        )}
        {typeof filePath === 'string' && (
          <code className="text-ink-muted font-mono truncate max-w-[250px]">
            {filePath}
          </code>
        )}
        {!filePath && !command && (tc.status === 'running' || tc.status === 'queued') && (
          <span className="text-ink-muted/60">running...</span>
        )}
        {startTime && tc.status !== 'running' && tc.status !== 'queued' && (
          <span className="text-ink-muted/50 ml-auto text-[10px]">{formatDuration(Date.now() - startTime)}</span>
        )}

        <span className="ml-auto shrink-0">
          {expanded ? <ChevronDown className="h-3 w-3 text-ink-muted" /> : <ChevronRight className="h-3 w-3 text-ink-muted" />}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border/50 px-3 py-2 space-y-2 bg-background/30">
          {argsStr && argsStr !== '{}' && (
            <div>
              <p className="text-[10px] font-medium text-ink-muted mb-1 uppercase tracking-wider">Arguments</p>
              <pre className="text-[11px] text-foreground/70 bg-background rounded p-2 overflow-x-auto max-h-32 overflow-y-auto font-mono">
                {argsStr}
              </pre>
            </div>
          )}
          {tc.output && (
            <div>
              <p className="text-[10px] font-medium text-ink-muted mb-1 uppercase tracking-wider">Output</p>
              <pre className="text-[11px] text-foreground/70 bg-background rounded p-2 overflow-x-auto max-h-48 overflow-y-auto font-mono whitespace-pre-wrap break-all">
                {tc.output.slice(0, 5000)}
              </pre>
            </div>
          )}
          {tc.error && (
            <div>
              <p className="text-[10px] font-medium text-red-400 mb-1 uppercase tracking-wider">Error</p>
              <pre className="text-[11px] text-red-400/80 bg-red-500/5 rounded p-2 overflow-x-auto font-mono">
                {tc.error}
              </pre>
            </div>
          )}
          {typeof filePath === 'string' && onFileSelect && tc.status === 'completed' && (
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

// ── Thinking indicator ───────────────────────────────────────────────────

function ThinkingIndicator() {
  return (
    <div className="ml-6 flex items-center gap-2 text-xs text-ink-muted/70 py-1">
      <div className="flex gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '150ms' }} />
        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '300ms' }} />
      </div>
      <span>Thinking...</span>
    </div>
  );
}

// ── Status bar ───────────────────────────────────────────────────────────

function AgentStatusIndicator({ stepCount, duration, isRunning, streamingText, messages }: {
  stepCount: number;
  duration: number;
  isRunning: boolean;
  streamingText?: string;
  messages: AgentMessage[];
}) {
  if (!isRunning) return null;

  // Count tools from the last assistant message
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const toolCalls = lastAssistant?.toolCalls || [];
  const runningTools = toolCalls.filter((tc) => tc.status === 'running' || tc.status === 'queued');
  const completedTools = toolCalls.filter((tc) => tc.status === 'completed');
  const currentTool = runningTools[0];

  let statusText = 'Thinking...';
  let statusIcon = '◌';
  if (streamingText) {
    statusText = 'Generating response...';
    statusIcon = '◉';
  } else if (currentTool) {
    const label = TOOL_LABELS[currentTool.toolName] || currentTool.toolName;
    const cmd = typeof currentTool.arguments === 'object' && currentTool.arguments !== null
      ? (currentTool.arguments as Record<string, unknown>).command
      : undefined;
    statusText = typeof cmd === 'string' ? `Running: ${cmd}` : `${label}...`;
    statusIcon = '⚙';
  } else if (stepCount > 0) {
    statusText = `Step ${stepCount} — LLM thinking...`;
    statusIcon = '◌';
  }

  return (
    <div className="flex items-center gap-2 px-4 py-2 text-xs glass-border-bottom bg-muted/20">
      <span className="text-blue-400 animate-pulse">{statusIcon}</span>
      <span className="text-foreground/70">{statusText}</span>
      <span className="text-ink-muted/50">·</span>
      <span>{formatDuration(duration)}</span>
      {completedTools.length > 0 && (
        <>
          <span className="text-ink-muted/50">·</span>
          <span className="text-green-500/70">{completedTools.length} done</span>
        </>
      )}
      {toolCalls.length > 0 && (
        <>
          <span className="text-ink-muted/50">·</span>
          <span>{toolCalls.length} tool{toolCalls.length !== 1 ? 's' : ''}</span>
        </>
      )}
    </div>
  );
}

// ── Main AgentChat ───────────────────────────────────────────────────────

export function AgentChat({ sessionId, workspacePath, isRunning, onStatusChange, onFileSelect, model, provider, onModelChange, injectedPrompt, sessions = [], activeSessionId, onSelectSession, onNewSession }: Props) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [stepCount, setStepCount] = useState(0);
  const [duration, setDuration] = useState(0);
  const [pendingPermission, setPendingPermission] = useState<{ toolCallId: string; toolName: string; args: unknown } | null>(null);
  const [pendingAskUser, setPendingAskUser] = useState<{ toolCallId: string; question: string; options: Array<{ label: string; description: string }>; multiple: boolean } | null>(null);
  const [isUserScrolled, setIsUserScrolled] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
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
      await agentApi.runAgent(sessionId, text, { workspacePath, model, provider });
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
  }, [input, isRunning, sessionId, workspacePath, model, provider, onStatusChange]);

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
  // Messages interleaved with tool calls
  const renderConversation = () => {
    const elements: React.ReactNode[] = [];

    // Render persisted messages
    messages.forEach((msg) => {
      if (msg.role === 'user') {
        elements.push(
          <div key={msg.id} className="flex justify-end">
            <div className="max-w-[85%] rounded-lg bg-primary/10 border border-primary/20 px-3 py-2 text-sm text-foreground">
              <div className="whitespace-pre-wrap break-words">{msg.content}</div>
            </div>
          </div>
        );
      } else if (msg.role === 'system') {
        elements.push(
          <div key={msg.id} className="flex items-start gap-2 rounded-md bg-yellow-500/5 border border-yellow-500/20 px-3 py-2 text-xs text-yellow-500/80">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <div className="whitespace-pre-wrap break-words">{msg.content}</div>
          </div>
        );
      } else if (msg.role === 'tool') {
        // Tool messages are handled by toolCalls on assistant messages, skip
      } else if (msg.role === 'assistant') {
        // Render content
        if (msg.content) {
          elements.push(
            <div key={msg.id} className="space-y-2">
              <div className="flex items-start gap-2">
                <Bot className="h-4 w-4 shrink-0 mt-1 text-foreground/60" />
                <div className="flex-1 min-w-0">
                  <MarkdownRenderer content={msg.content} onFileSelect={onFileSelect} />
                </div>
              </div>
            </div>
          );
        }
        // Render tool calls inline right after the content
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          msg.toolCalls.forEach((tc) => {
            const startTime = toolStartTimes.current.get(tc.id);
            elements.push(
              <InlineToolCard
                key={`tc-${tc.id}`}
                tc={tc}
                startTime={startTime}
                onFileSelect={onFileSelect}
              />
            );
          });
        }
      }
    });

    // Render streaming text
    if (streamingText) {
      elements.push(
        <div key="streaming" className="space-y-2">
          <div className="flex items-start gap-2">
            <Bot className="h-4 w-4 shrink-0 mt-1 text-foreground/60" />
            <div className="flex-1 min-w-0">
              <MarkdownRenderer content={streamingText} onFileSelect={onFileSelect} />
              <span className="inline-block w-1.5 h-4 bg-foreground/50 animate-pulse ml-0.5 align-text-bottom" />
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
          <div key="thinking" className="flex items-start gap-2">
            <Bot className="h-4 w-4 shrink-0 mt-1 text-foreground/60" />
            <ThinkingIndicator />
          </div>
        );
      }
    }

    return elements;
  };

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Chat header: current chat + history toggle */}
      <div className="relative flex h-10 shrink-0 items-center gap-2 border-b border-border/40 px-3">
        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/85">
          {sessions.find((s) => s.id === activeSessionId)?.title || 'New chat'}
        </span>
        {onNewSession && (
          <button
            onClick={onNewSession}
            title="New chat"
            aria-label="New chat"
            className="glass-hover rounded p-1 text-ink-muted transition-colors hover:text-foreground"
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
              'glass-hover rounded p-1 transition-colors',
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

      {/* Status bar */}
      <AgentStatusIndicator
        stepCount={stepCount}
        duration={duration}
        isRunning={isRunning}
        streamingText={streamingText}
        messages={messages}
      />

      {/* Toolbar */}
      {!isRunning && messages.length > 0 && (
        <div className="flex items-center justify-end px-4 py-1 border-b border-border/30">
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
        className="flex-1 overflow-y-auto px-4 py-4 space-y-3 scrollbar-thin"
      >
        {messages.length === 0 && !streamingText && !isRunning && (
          <div className="flex flex-col items-center justify-center h-full text-ink-muted">
            <div className="text-center space-y-3 max-w-sm">
              <div className="mx-auto h-12 w-12 rounded-xl glass-panel flex items-center justify-center">
                <Send className="h-5 w-5 text-ink-muted/50" />
              </div>
              <h3 className="text-sm font-medium text-foreground/80">Ask anything</h3>
              <p className="text-xs text-ink-muted/70 leading-relaxed">
                Read code, fix bugs, add features, run tests, or explore your codebase.
              </p>
              <div className="grid grid-cols-2 gap-1.5 mt-3">
                {[
                  'Read the project structure',
                  'Find and fix bugs',
                  'Add a new feature',
                  'Run tests',
                ].map((prompt) => (
                  <button
                    key={prompt}
                    onClick={() => { setInput(prompt); inputRef.current?.focus(); }}
                    className="rounded-md glass-panel px-2.5 py-2 text-[11px] text-ink-muted glass-hover transition-colors text-left"
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
                className="mt-3 flex items-center gap-1.5 rounded-md glass-panel px-3 py-2 text-[11px] text-ink-muted glass-hover transition-colors"
              >
                <Code2 className="h-3 w-3" /> Open in Smoke Monkey IDE
              </button>
            </div>
          </div>
        )}

        {renderConversation()}

        <div ref={messagesEndRef} />
      </div>

      {/* Permission request */}
      {pendingPermission && (
        <div className="mx-4 mb-2 rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />
            <p className="text-xs font-medium">
              Allow <span className="font-mono text-yellow-500">{pendingPermission.toolName}</span>?
            </p>
          </div>
          <pre className="text-[11px] text-ink-muted max-h-16 overflow-y-auto mb-2 glass-panel rounded p-2">
            {JSON.stringify(pendingPermission.args, null, 2).slice(0, 300)}
          </pre>
          <div className="flex gap-2">
            <button onClick={async () => {
              if (pendingPermission) {
                await agentApi.resolvePermission(pendingPermission.toolCallId, 'allow');
                setPendingPermission(null);
              }
            }}
              className="flex items-center gap-1 rounded bg-green-600 px-3 py-1 text-xs text-white hover:bg-green-700 transition-colors">
              <Check className="h-3 w-3" /> Allow
            </button>
            <button onClick={async () => {
              if (pendingPermission) {
                await agentApi.resolvePermission(pendingPermission.toolCallId, 'deny');
                setPendingPermission(null);
              }
            }}
              className="flex items-center gap-1 rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700 transition-colors">
              <X className="h-3 w-3" /> Deny
            </button>
          </div>
        </div>
      )}

      {/* Ask user request */}
      {pendingAskUser && (
        <div className="sticky top-0 z-10 mx-4 mb-2 rounded-md border border-blue-500/50 bg-blue-500/10 p-4 shadow-lg shadow-blue-500/10 backdrop-blur-sm">
          <div className="flex items-center gap-2 mb-3">
            <div className="h-8 w-8 rounded-full bg-blue-500/20 flex items-center justify-center">
              <MessageSquare className="h-4 w-4 text-blue-500" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">Agent needs your input</p>
              <p className="text-[11px] text-ink-muted">Choose an option or type your response below</p>
            </div>
          </div>
          <p className="text-sm text-ink mb-3 leading-relaxed">{pendingAskUser.question}</p>
          {pendingAskUser.options.length > 0 ? (
            <div className="space-y-2">
              {pendingAskUser.options.map((opt, idx) => (
                <button key={idx} onClick={async () => {
                  await agentApi.resolveAskUser(pendingAskUser.toolCallId, opt.label);
                  setPendingAskUser(null);
                }}
                  className="w-full text-left rounded-lg glass-panel border border-border/50 p-3 hover:border-blue-500/50 hover:bg-blue-500/10 active:bg-blue-500/20 transition-all cursor-pointer">
                  <p className="text-xs font-medium text-foreground">{opt.label}</p>
                  <p className="text-[11px] text-ink-muted mt-0.5">{opt.description}</p>
                </button>
              ))}
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                type="text"
                id="ask-user-input"
                autoFocus
                className="flex-1 rounded-lg glass-panel px-3 py-2.5 text-sm placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                placeholder="Type your answer..."
                onKeyDown={async (e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    const val = (e.target as HTMLInputElement).value.trim();
                    if (val) {
                      await agentApi.resolveAskUser(pendingAskUser.toolCallId, val);
                      setPendingAskUser(null);
                    }
                  }
                }}
              />
              <button onClick={async () => {
                const input = document.getElementById('ask-user-input') as HTMLInputElement;
                const val = input?.value.trim();
                if (val) {
                  await agentApi.resolveAskUser(pendingAskUser.toolCallId, val);
                  setPendingAskUser(null);
                }
              }}
                className="flex items-center gap-1 rounded-lg bg-blue-600 px-4 py-2.5 text-sm text-white hover:bg-blue-700 active:bg-blue-800 transition-colors font-medium">
                Send
              </button>
            </div>
          )}
        </div>
      )}

      {/* Input area */}
      <div className="glass-border-top p-3">
        {/* Model picker + key indicator bar */}
        <div className="mb-2 flex items-center gap-2">
          {providers.length > 0 && onModelChange && (
            <ModelPicker
              providers={providers}
              provider={provider || 'ollama'}
              model={model || 'qwen3:8b'}
              onChange={onModelChange}
              compact
            />
          )}
          {needsKey && (
            <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">
              <KeyRound className="h-3 w-3" />
              Key required
            </span>
          )}
          {provider && !needsKey && hasKeyForCurrentProvider && (
            <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">
              <KeyRound className="h-3 w-3" />
              Key ready
            </span>
          )}
          {!provider || provider === 'ollama' ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-700 px-2 py-0.5 text-[10px] font-medium text-ink-muted">
              Local
            </span>
          ) : null}
        </div>
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isRunning ? 'Agent is working...' : 'Ask anything...'}
            disabled={isRunning}
            rows={1}
            className="flex-1 resize-none rounded-md glass-panel px-3 py-2 text-sm placeholder:text-ink-muted/50 focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 min-h-[36px] max-h-[120px]"
            style={{ height: 'auto', minHeight: '36px' }}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = 'auto';
              target.style.height = Math.min(target.scrollHeight, 120) + 'px';
            }}
          />
          {isRunning ? (
            <button onClick={handleInterrupt}
              className="flex items-center gap-1 rounded bg-red-600 px-2.5 py-2 text-xs text-white hover:bg-red-700 transition-colors shrink-0">
              <Square className="h-3 w-3" />
            </button>
          ) : (
            <button onClick={handleSend} disabled={!input.trim()}
              className="flex items-center gap-1 rounded bg-primary px-2.5 py-2 text-xs text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-30 shrink-0">
              <Send className="h-3 w-3" />
            </button>
          )}
        </div>
        <div className="mt-1.5 flex items-center text-[10px] text-ink-muted/40">
          <span>Enter to send · Shift+Enter for new line</span>
        </div>
      </div>
    </div>
  );
}
