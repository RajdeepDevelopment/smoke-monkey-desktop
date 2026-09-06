'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  LogOut,
  Menu,
  MessageSquarePlus,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type {
  CitationDto,
  ConversationDto,
  DocumentDto,
  ModelPreset,
  ModelProvider,
  UserKeyDto,
  WebSourceDto,
} from '@rag/contracts';
import { api } from '../lib/api';
import { estimateHistoryTokens } from '../lib/tokens';
import { useAuth } from './AuthProvider';
import { useToast } from './Toast';
import { BrandIcon } from './BrandIcon';
import { NAV } from './Sidebar';
import { useIsMobile } from '../lib/hooks';
import { MobileDrawer, MobileBottomNav } from './MobileNavigation';
import { MessageBubble, type BubbleMessage } from './MessageBubble';
import { ChatComposer } from './chat/ChatComposer';
import { SourcesPanel } from './chat/SourcesPanel';
import { MemoryIndicator } from './chat/MemoryIndicator';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from './ui/sheet';
import { cn } from '../lib/utils';

const STREAM_ID = 'tmp-assistant';
const STREAM_THROTTLE_MS = 40;

let seq = 0;
const nextId = () => `m-${Date.now()}-${seq++}`;

const SUGGESTED_PROMPTS = [
  'Ask about my documents',
  'What do you know about me?',
  'Summarize my uploaded PDFs',
  'Explain how hybrid retrieval works',
];

interface StageItem {
  label: string;
  done: boolean;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function ConversationList({
  conversations,
  activeId,
  streaming,
  onOpen,
  onDelete,
  onNewChat,
}: {
  conversations: ConversationDto[];
  activeId: string | null;
  streaming: boolean;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onNewChat: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 pt-3">
        <button
          type="button"
          onClick={onNewChat}
          disabled={streaming}
          className="btn-primary w-full justify-center gap-2"
        >
          <MessageSquarePlus className="h-4 w-4" />
          New chat
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3 scrollbar-thin">
        <p className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-widest text-ink-muted">
          Recent chats
        </p>
        <div className="space-y-0.5">
          {conversations.length === 0 && (
            <p className="px-2 py-2 text-xs text-ink-muted">No conversations yet.</p>
          )}
          {conversations.map((c) => {
            const active = c.id === activeId;
            return (
              <div
                key={c.id}
                className={cn(
                  'group relative rounded-lg transition-colors',
                  active ? 'bg-primary-subtle' : 'hover:bg-surface-800',
                )}
              >
                <button
                  type="button"
                  onClick={() => onOpen(c.id)}
                  disabled={streaming}
                  className={cn(
                    'w-full truncate px-3 py-2 pr-8 text-left text-[13px]',
                    active ? 'font-medium text-white' : 'text-ink-secondary group-hover:text-white',
                  )}
                  title={c.title}
                >
                  {c.title}
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(c.id)}
                  disabled={streaming}
                  title="Delete conversation"
                  className="absolute right-1 top-1/2 hidden h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-ink-muted hover:bg-surface-700 hover:text-red-400 group-hover:flex"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function ChatPanel({
  initialConversationId,
  initialProvider,
  initialModel,
}: {
  initialConversationId?: string;
  initialProvider?: string;
  initialModel?: string;
}) {
  const { user, loading: authLoading, logout } = useAuth();
  const toast = useToast();
  const router = useRouter();

  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<BubbleMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [stages, setStages] = useState<StageItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [presets, setPresets] = useState<ModelPreset[]>([]);
  const [defaultProvider, setDefaultProvider] = useState<string>('nvidia');
  const [provider, setProvider] = useState('ollama');
  const [model, setModel] = useState('');
  const [savedKeys, setSavedKeys] = useState<UserKeyDto[]>([]);
  const [documents, setDocuments] = useState<DocumentDto[]>([]);
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [omnirouteServerEnabled, setOmnirouteServerEnabled] = useState(false);
  const [omnirouteModels, setOmnirouteModels] = useState<string[]>([]);
  const [openrouterModels, setOpenrouterModels] = useState<string[]>([]);
  const [webSearchServerEnabled, setWebSearchServerEnabled] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);

  const lastSelectionRef = useRef<{ provider: string; model: string } | null>(null);

  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [sourceCitations, setSourceCitations] = useState<CitationDto[]>([]);
  const [sourceWebSources, setSourceWebSources] = useState<WebSourceDto[]>([]);
  const [activeSourceIndex, setActiveSourceIndex] = useState<number | null>(null);

  const isMobile = useIsMobile();

  const abortRef = useRef<AbortController | null>(null);
  const initRef = useRef(false);
  const activeIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const streamBufferRef = useRef('');
  const lastStreamFlushRef = useRef(0);

  activeIdRef.current = activeId;

  const isFresh = messages.length === 0;

  const historyTokens = useMemo(() => estimateHistoryTokens(messages), [messages]);
  const ragActive = selectedDocIds.size > 0 || documents.length > 0;

  const omnirouteMode = provider === 'omniroute';

  const refreshKeys = useCallback(async () => {
    try {
      const { keys } = await api.listKeys();
      setSavedKeys(keys);
    } catch {
      setSavedKeys([]);
    }
  }, []);

  useEffect(() => {
    if (!user || initRef.current) return;
    initRef.current = true;
    void refreshConversations();
    if (initialConversationId) {
      void openConversation(initialConversationId).catch(() => {
        setActiveId(null);
        setMessages([]);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, initialConversationId]);

  useEffect(() => {
    api
      .fetchModels()
      .then((res) => {
        setProviders(res.providers);
        setPresets(res.presets ?? []);
        setDefaultProvider(res.defaultProvider ?? 'nvidia');
        const preferred =
          res.providers.find((p) => p.id === 'nvidia') ??
          res.providers.find((p) => p.id === res.defaultProvider) ??
          res.providers[0];
        // A provider/model may be pinned via ?provider=&model= (e.g. selecting
        // an OmniRoute model from the /models page). Prefer it over the
        // default so the requested model is selected on load.
        const requestedProvider = res.providers.find((p) => p.id === initialProvider);
        setProvider(requestedProvider ? initialProvider! : (preferred?.id ?? 'ollama'));
        setModel(
          initialProvider && initialModel
            ? initialModel
            : (requestedProvider?.models[0] ?? preferred?.models[0] ?? ''),
        );
      })
      .catch(() => setProviders([]));
    api
      .fetchSettings()
      .then((s) => {
        setOmnirouteServerEnabled(s.omniroute.serverEnabled);
        setWebSearchServerEnabled(s.webSearch.serverEnabled);
        setWebSearchEnabled(s.webSearch.serverEnabled && s.webSearch.enabled);
      })
      .catch(() => {
        setOmnirouteServerEnabled(false);
        setWebSearchServerEnabled(false);
        setWebSearchEnabled(false);
      });
    void refreshKeys();
    if (user) {
      api
        .listDocuments()
        .then((docs) => setDocuments(docs.filter((d) => d.status === 'ready')))
        .catch(() => setDocuments([]));
    }
  }, [user, refreshKeys]);

  // When the user enters free OmniRoute mode, pull the live keyless model list
  // from the local gateway so the picker shows every free model, not just the
  // curated subset from /models.
  useEffect(() => {
    if (provider !== 'omniroute') return;
    api
      .fetchOmniRouteModels()
      .then((res) => setOmnirouteModels(res.models.map((m) => m.id)))
      .catch(() => setOmnirouteModels([]));
  }, [provider]);

  // The OpenRouter feed changes often (new families, :free drops, renames), so
  // the picker also pulls the live 400+ list and merges it under the curated
  // default models when the OpenRouter provider is selected.
  useEffect(() => {
    if (provider !== 'openrouter') return;
    api
      .fetchOpenRouterModels()
      .then((res) => setOpenrouterModels(res.models.map((m) => m.id)))
      .catch(() => setOpenrouterModels([]));
  }, [provider]);

  const displayProviders = useMemo(() => {
    if (omnirouteModels.length === 0 && openrouterModels.length === 0) return providers;
    const live = (p: string) => {
      if (p === 'omniroute') return omnirouteModels;
      if (p === 'openrouter') return openrouterModels;
      return [];
    };
    return providers.map((p) => {
      const extra = live(p.id);
      if (extra.length === 0) return p;
      return { ...p, models: Array.from(new Set([...p.models, ...extra])) };
    });
  }, [providers, omnirouteModels, openrouterModels]);

  const toggleOmniRoute = useCallback(async () => {
    const turningOn = provider !== 'omniroute';
    try {
      if (turningOn) {
        lastSelectionRef.current = { provider, model };
        setProvider('omniroute');
        setModel('auto');
        await api.setOmniRouteEnabled(true);
        toast.success('Free OmniRoute mode is on', 'Using 100+ free, keyless models — no API key needed.');
      } else {
        const prev = lastSelectionRef.current;
        setProvider(prev?.provider ?? defaultProvider);
        setModel(prev?.model ?? '');
        await api.setOmniRouteEnabled(false);
        toast.info('Free OmniRoute mode is off');
      }
    } catch (err) {
      toast.error('Could not update OmniRoute', (err as Error).message);
    }
  }, [provider, model, defaultProvider, toast]);

  const toggleWebSearch = useCallback(async () => {
    const next = !webSearchEnabled;
    try {
      const res = await api.setWebSearchEnabled(next);
      setWebSearchEnabled(res.webSearch.serverEnabled && res.webSearch.enabled);
      if (next) toast.success('Web search is on', 'Answers can now include fresh web results.');
      else toast.info('Web search is off');
    } catch (err) {
      toast.error('Could not update web search', (err as Error).message);
    }
  }, [webSearchEnabled, toast]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  useEffect(() => {
    const url = activeId ? `/chat?c=${activeId}` : '/chat';
    window.history.replaceState(null, '', url);
  }, [activeId]);

  const refreshConversations = useCallback(async () => {
    const list = await api.listConversations();
    setConversations(list);
    if (activeId && !list.some((c) => c.id === activeId)) setActiveId(null);
  }, [activeId]);

  const openConversation = useCallback(
    async (id: string) => {
      if (streaming) return;
      if (id === activeIdRef.current) return;
      setActiveId(id);
      setError(null);
      setStages([]);
      setSourcesOpen(false);
      setActiveSourceIndex(null);
      stickToBottomRef.current = true;
      try {
        const history = await api.getMessages(id);
        setMessages(
          history.map((m) => ({
            id: m.id,
            role: m.role === 'user' ? 'user' : 'assistant',
            content: m.content,
            citations: m.citations,
            webSources: m.webSources,
            confidence: m.confidence,
          })),
        );
      } catch (err) {
        setError((err as Error).message || 'Failed to load conversation');
      }
    },
    [streaming],
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      if (streaming) return;
      try {
        await api.deleteConversation(id);
      } catch {
        return;
      }
      if (activeId === id) {
        setActiveId(null);
        setMessages([]);
        setSourcesOpen(false);
      }
      void refreshConversations();
    },
    [streaming, activeId, refreshConversations],
  );

  const newChat = useCallback(() => {
    if (streaming) return;
    setActiveId(null);
    setMessages([]);
    setError(null);
    setStages([]);
    setSourcesOpen(false);
    setSourceWebSources([]);
    setActiveSourceIndex(null);
    setInput('');
    stickToBottomRef.current = true;
  }, [streaming]);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const patchStreaming = useCallback(
    (patch: Partial<BubbleMessage>) => {
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === STREAM_ID);
        if (idx === -1) return prev;
        if (
          prev[idx].content === (patch.content ?? prev[idx].content) &&
          prev[idx].citations === (patch.citations ?? prev[idx].citations) &&
          prev[idx].webSources === (patch.webSources ?? prev[idx].webSources) &&
          prev[idx].pending === (patch.pending ?? prev[idx].pending) &&
          prev[idx].notice === (patch.notice ?? prev[idx].notice)
        ) {
          return prev;
        }
        const next = prev.slice();
        next[idx] = { ...prev[idx], ...patch };
        return next;
      });
    },
    [],
  );

  const flushStream = useCallback(() => {
    patchStreaming({ content: streamBufferRef.current });
    lastStreamFlushRef.current = performance.now();
  }, [patchStreaming]);

  // Guarantee progressive rendering even when the upstream delivers the whole
  // stream in one or two network bursts (common on localhost / fast models):
  // the arrival-throttle in `send` only fires on chunk events, so without this
  // periodic flush a fast or short answer appears all at once instead of
  // token-by-token. `patchStreaming` no-ops when content is unchanged, so idle
  // ticks cost nothing.
  useEffect(() => {
    if (!streaming) return;
    const interval = setInterval(flushStream, 50);
    return () => clearInterval(interval);
  }, [streaming, flushStream]);

  const pushStage = useCallback((label: string) => {
    setStages((prev) => {
      const clean = label.replace(/…$/, '').replace(/\.\.\.$/, '').trim();
      if (!clean) return prev;
      if (prev.length && prev[prev.length - 1].label === clean) return prev;
      return [...prev.map((s) => ({ ...s, done: true })), { label: clean, done: false }];
    });
  }, []);

  const completeStages = useCallback(() => {
    setStages((prev) => prev.map((s) => ({ ...s, done: true })));
  }, []);

  const send = useCallback(
    async (textOverride?: string) => {
      const text = (textOverride ?? input).trim();
      if (!text || streaming) return;

      setInput('');
      setError(null);
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'user', content: text },
        { id: STREAM_ID, role: 'assistant', content: '', pending: true },
      ]);
      setStreaming(true);
      setStages([{ label: 'Understanding your question', done: false }]);
      stickToBottomRef.current = true;
      streamBufferRef.current = '';
      lastStreamFlushRef.current = 0;

      const controller = new AbortController();
      abortRef.current = controller;

      let assistantContent = '';
      let citations: CitationDto[] | null = null;
      let webSources: WebSourceDto[] | null = null;
      let confidence = 0;
      let notice: string | null = null;

      try {
        for await (const event of api.streamChat(
          text,
          activeId ?? undefined,
          controller.signal,
          provider,
          model,
          selectedDocIds.size > 0 ? [...selectedDocIds] : undefined,
        )) {
          switch (event.type) {
            case 'meta':
              setActiveId((prev) => prev ?? event.conversationId);
              break;
            case 'sources':
              citations = event.citations;
              patchStreaming({ citations });
              break;
            case 'web_sources':
              webSources = event.sources;
              patchStreaming({ webSources });
              break;
            case 'status':
              pushStage(event.label);
              break;
            case 'chunk':
              completeStages();
              assistantContent += event.text;
              streamBufferRef.current = assistantContent;
              if (performance.now() - lastStreamFlushRef.current >= STREAM_THROTTLE_MS) {
                flushStream();
              }
              break;
            case 'done':
              confidence = event.confidence ?? 0;
              citations = event.citations ?? citations;
              webSources = event.webSources ?? webSources;
              break;
            case 'notice':
              notice = event.message;
              patchStreaming({ notice });
              break;
            case 'error':
              throw new Error(event.message);
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError((err as Error).message || 'Something went wrong');
        }
      } finally {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === STREAM_ID
              ? {
                  ...m,
                  id: nextId(),
                  content: assistantContent || streamBufferRef.current || m.content,
                  citations: citations ?? m.citations,
                  webSources: webSources ?? m.webSources,
                  confidence,
                  notice: notice ?? m.notice,
                  pending: false,
                }
              : m,
          ),
        );
        setStreaming(false);
        setStages([]);
        void refreshConversations();
      }
    },
    [input, streaming, activeId, refreshConversations, provider, model, selectedDocIds, pushStage, completeStages, flushStream, patchStreaming],
  );

  // ── Sources ───────────────────────────────────────────────────────────────
  const lastCited = [...messages]
    .reverse()
    .find(
      (m) =>
        m.role === 'assistant' &&
        ((m.citations?.length ?? 0) > 0 || (m.webSources?.length ?? 0) > 0),
    );
  const sourceCount = (lastCited?.citations ?? []).filter((c) => c.text && c.text.trim().length > 0).length;
  const webSourceCount = (lastCited?.webSources ?? []).filter((s) => s.url || s.content).length;
  const totalSourceCount = sourceCount + webSourceCount;

  const openSources = useCallback(
    (citations: CitationDto[], webSources: WebSourceDto[], highlight?: number) => {
      setSourceCitations(citations);
      setSourceWebSources(webSources);
      setActiveSourceIndex(highlight ?? null);
      setSourcesOpen(true);
    },
    [],
  );

  const toggleSources = useCallback(() => {
    setSourcesOpen((open) => {
      if (!open) {
        setSourceCitations(lastCited?.citations ?? []);
        setSourceWebSources(lastCited?.webSources ?? []);
        setActiveSourceIndex(null);
        return true;
      }
      return false;
    });
  }, [lastCited]);

  const attachFile = useCallback(
    async (file: File) => {
      if (!file) return;
      try {
        const doc = await api.uploadDocument(file);
        toast.success('Upload started', `${doc.filename} — indexing in progress.`);
        const docs = await api.listDocuments();
        setDocuments(docs.filter((d) => d.status === 'ready'));
        setSelectedDocIds((prev) => new Set(prev).add(doc.id));
      } catch (err) {
        toast.error('Upload failed', (err as Error).message);
      }
    },
    [toast],
  );

  const handleModelChange = useCallback((p: string, m: string) => {
    setProvider(p);
    setModel(m);
  }, []);

  const handleLogout = () => {
    logout();
    router.push('/login');
  };

  if (authLoading) return <div className="p-8 text-sm text-ink-muted">Loading…</div>;
  if (!user) {
    return (
      <div className="relative flex h-full flex-col overflow-hidden">
        <div className="card mx-auto my-auto max-w-lg text-center">
          <p className="mb-4 text-ink-secondary">Sign in to start chatting with your documents.</p>
          <a href="/login" className="btn-primary">
            Sign in
          </a>
        </div>
        <MobileBottomNav />
      </div>
    );
  }

  const userName = user.name || user.email || 'Account';
  const activeTitle = conversations.find((c) => c.id === activeId)?.title ?? 'New chat';

  const composer = (
    <ChatComposer
      input={input}
      onInputChange={setInput}
      streaming={streaming}
      onSend={() => void send()}
      onStop={stopStreaming}
      disabled={!user}
      documents={documents}
      selectedDocIds={selectedDocIds}
      onToggleDoc={(id) =>
        setSelectedDocIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        })
      }
      onClearScope={() => setSelectedDocIds(new Set())}
      savedKeys={savedKeys}
      onKeysChanged={() => void refreshKeys()}
      providers={displayProviders}
      provider={provider}
      model={model}
      defaultProvider={defaultProvider}
      presets={presets}
      onModelChange={handleModelChange}
      onAttach={attachFile}
      omnirouteServerEnabled={omnirouteServerEnabled}
      omnirouteMode={omnirouteMode}
      onToggleOmniRoute={() => void toggleOmniRoute()}
      webSearchServerEnabled={webSearchServerEnabled}
      webSearchEnabled={webSearchEnabled}
      onToggleWebSearch={() => void toggleWebSearch()}
      historyTokens={historyTokens}
      ragActive={ragActive}
    />
  );

  const sourcesButton = totalSourceCount > 0 ? (
    <button
      type="button"
      onClick={toggleSources}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
        sourcesOpen
          ? 'border-primary/50 bg-primary-subtle text-white'
          : 'border-surface-600/70 bg-surface-800/60 text-ink-secondary hover:border-primary/40 hover:text-white',
      )}
    >
      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary/20 text-[9px] font-semibold text-primary">
        {totalSourceCount}
      </span>
      {webSourceCount > 0 && sourceCount > 0 ? 'Sources' : webSourceCount > 0 ? 'Web' : 'Sources'}
    </button>
  ) : null;

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden lg:flex-row">
      {/* ── Desktop conversation column (lg+) ─────────────────────────────── */}
      <aside className="hidden w-72 shrink-0 flex-col border-r border-surface-800 bg-surface-950 lg:flex">
        <div className="flex items-center gap-2 px-3 pb-2 pt-3">
          <Link href="/" className="flex items-center gap-2 text-sm font-semibold text-white">
            <BrandIcon size={40} className="rounded-lg" />
            Smoke Monkey
          </Link>
        </div>

        <ConversationList
          conversations={conversations}
          activeId={activeId}
          streaming={streaming}
          onOpen={(id) => void openConversation(id)}
          onDelete={(id) => void deleteConversation(id)}
          onNewChat={newChat}
        />

        <div className="border-t border-surface-800 px-2 py-2">
          <div className="mb-1 grid grid-cols-4 gap-1">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                title={item.label}
                className="flex h-9 flex-col items-center justify-center gap-0.5 rounded-lg text-ink-muted transition-colors hover:bg-surface-800 hover:text-white"
              >
                <item.icon className="h-4 w-4" />
                <span className="text-[9px] leading-none">{item.label.split(' ')[0]}</span>
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2 rounded-lg px-2 py-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[11px] font-semibold text-primary">
              {userName.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink-primary">
              {user.name || user.email}
            </span>
            <button
              type="button"
              title="Sign out"
              onClick={handleLogout}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-800 hover:text-red-300"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* ── Chat workspace ───────────────────────────────────────────────── */}
      <main className="relative flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden bg-bg">
        {/* Mobile top bar */}
        <header className="flex h-14 shrink-0 items-center justify-between gap-1.5 border-b border-surface-800 bg-surface-950/80 px-2.5 backdrop-blur lg:hidden">
          <MobileDrawer
            recentChats={conversations}
            activeChatId={activeId}
            onOpenChat={(id) => void openConversation(id)}
            onNewChat={newChat}
            trigger={
              <button
                type="button"
                className="flex h-10 w-10 min-h-[40px] min-w-[40px] shrink-0 items-center justify-center rounded-lg text-ink-secondary transition-colors hover:bg-surface-800 hover:text-white"
                aria-label="Open navigation"
              >
                <Menu className="h-5 w-5" />
              </button>
            }
          />

          <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
            <BrandIcon size={36} className="shrink-0 rounded-md" />
            <span className="truncate text-sm font-semibold text-white">{isFresh ? 'New chat' : activeTitle}</span>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {sourcesButton && <div className="shrink-0 lg:hidden">{sourcesButton}</div>}
            <div className="shrink-0">
              <MemoryIndicator />
            </div>

            <button
              type="button"
              onClick={newChat}
              disabled={streaming}
              className="flex h-10 w-10 min-h-[40px] min-w-[40px] shrink-0 items-center justify-center rounded-lg text-ink-secondary transition-colors hover:bg-surface-800 hover:text-white disabled:opacity-40"
              aria-label="New chat"
              title="New chat"
            >
              <Plus className="h-5 w-5" />
            </button>
          </div>
        </header>

        {/* Desktop header */}
        {!isFresh && (
          <header className="hidden shrink-0 items-center justify-between gap-4 border-b border-surface-800 px-6 py-4 lg:flex">
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold text-white">{activeTitle}</h1>
              <p className="text-xs text-ink-muted">Ask anything, get intelligent answers.</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="hidden items-center gap-1.5 rounded-full border border-surface-600/70 bg-surface-800/60 px-2.5 py-1 text-[11px] font-medium text-ink-secondary xl:inline-flex">
                <Sparkles className="h-3 w-3 text-primary" />
                Hybrid Search + Super Memory
              </span>
              <MemoryIndicator />
              {sourcesButton}
              <button
                type="button"
                onClick={newChat}
                disabled={streaming}
                className="inline-flex items-center gap-1.5 rounded-full border border-surface-600/70 bg-surface-800/60 px-2.5 py-1 text-[11px] font-medium text-ink-secondary transition-colors hover:border-primary/40 hover:text-white disabled:opacity-40"
              >
                <Plus className="h-3.5 w-3.5" />
                New chat
              </button>
            </div>
          </header>
        )}

        {isFresh ? (
          /* ── Fresh chat ───────────────────────────────────────────────── */
          <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-6 overflow-y-auto px-4 pb-8 pt-6 sm:px-6">
            <div className="fade-in text-center">
              <div className="mx-auto mb-3.5 flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl bg-primary/15">
                <BrandIcon size={56} />
              </div>
              <h2 className="text-lg font-semibold text-white sm:text-2xl">Smoke Monkey AI</h2>
              <p className="mt-1 text-xs text-ink-muted sm:text-sm">How can I help you today?</p>
            </div>

            <div className="w-full max-w-3xl">{composer}</div>

            <div className="flex flex-wrap items-center justify-center gap-2">
              {SUGGESTED_PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => void send(p)}
                  disabled={streaming}
                  className="rounded-full border border-surface-600 bg-surface-800/50 px-3.5 py-1.5 text-xs text-ink-secondary transition-colors hover:border-primary/40 hover:text-white disabled:opacity-50"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* ── Active conversation ──────────────────────────────────────── */
          <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
            <div ref={scrollRef} onScroll={handleScroll} className="flex-1 min-h-0 overflow-y-auto px-3.5 py-4 sm:px-6 scrollbar-thin">
              <div className="mx-auto max-w-3xl space-y-6 pb-6">
                {messages.map((m) => (
                  <MessageBubble
                    key={m.id}
                    message={m}
                    stages={stages}
                    onOpenSources={openSources}
                    onHighlight={setActiveSourceIndex}
                  />
                ))}
              </div>
            </div>

            {error && (
              <div className="shrink-0 border-t border-error/30 bg-error/10 px-4 py-2 text-sm text-red-300 sm:px-6">
                {error}
              </div>
            )}

            <div className="shrink-0 px-2.5 pb-2.5 pt-1.5 sm:px-6 sm:pb-5">
              <div className="mx-auto max-w-3xl">{composer}</div>
            </div>
          </div>
        )}
      </main>

      {/* Backdrop blur behind the sources panel */}
      <div
        className={cn(
          'absolute inset-0 z-30 hidden bg-black/45 backdrop-blur-[2px] transition-opacity duration-300 lg:block',
          sourcesOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={() => setSourcesOpen(false)}
      />

      {/* ── Desktop sources panel (overlay from right) ──────────────────── */}
      <div
        className={cn(
          'absolute inset-y-0 right-0 z-40 hidden w-[360px] flex-col border-l border-surface-800 bg-surface-950/95 shadow-2xl backdrop-blur transition-transform duration-300 ease-out lg:flex',
          sourcesOpen ? 'translate-x-0' : 'pointer-events-none translate-x-full',
        )}
      >
        <div className="flex items-center justify-between border-b border-surface-800 px-4 py-3">
          <span className="text-xs text-ink-muted">
            {sourceCitations.length + sourceWebSources.length} items
          </span>
          <button
            type="button"
            onClick={() => setSourcesOpen(false)}
            className="flex h-7 w-7 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-surface-800 hover:text-white"
            title="Close sources"
          >
            ×
          </button>
        </div>
        <SourcesPanel
          webSources={sourceWebSources}
          citations={sourceCitations}
          activeIndex={activeSourceIndex}
          onHighlight={setActiveSourceIndex}
          className="flex-1"
        />
      </div>

      {/* ── Mobile sources sheet ────────────────────────────────────────── */}
      <Sheet open={sourcesOpen && isMobile} onOpenChange={setSourcesOpen}>
        <SheetContent side="bottom" className="flex max-h-[70vh] flex-col gap-0 p-0 lg:hidden">
          <SheetHeader className="border-b border-surface-800 px-4 py-3">
            <SheetTitle className="text-sm">Sources</SheetTitle>
          </SheetHeader>
          <SourcesPanel
            webSources={sourceWebSources}
            citations={sourceCitations}
            activeIndex={activeSourceIndex}
            onHighlight={setActiveSourceIndex}
            className="flex-1"
          />
        </SheetContent>
      </Sheet>

      {/* ── Mobile bottom navigation (always available) ─────────────────── */}
      <MobileBottomNav />
    </div>
  );
}
