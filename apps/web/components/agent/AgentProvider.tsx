'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentMessage, AgentEvent } from '../../lib/agent-api';
import { agentApi } from '../../lib/agent-api';

type AgentStatus = 'idle' | 'thinking' | 'streaming' | 'tool_call' | 'error' | 'done';

interface ActiveTool {
  name: string;
  args: unknown;
  status: 'running' | 'completed' | 'failed' | 'output';
  output?: string;
  result?: unknown;
  startTime?: number;
}

interface AgentState {
  status: AgentStatus;
  messages: AgentMessage[];
  streamingText: string;
  activeTools: Map<string, ActiveTool>;
  stepCount: number;
  duration: number;
  error?: string;
  pendingPermission?: {
    toolCallId: string;
    toolName: string;
    args: unknown;
  };
}

interface AgentContextValue {
  state: AgentState;
  sendMessage: (text: string, options?: { workspacePath?: string; model?: string; provider?: string }) => Promise<void>;
  interrupt: () => Promise<void>;
  loadMessages: (sessionId: string) => Promise<void>;
  resolvePermission: (toolCallId: string, effect: 'allow' | 'deny') => Promise<void>;
  clearError: () => void;
}

const AgentContext = createContext<AgentContextValue | null>(null);

export function AgentProvider({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  const [state, setState] = useState<AgentState>({
    status: 'idle',
    messages: [],
    streamingText: '',
    activeTools: new Map(),
    stepCount: 0,
    duration: 0,
  });

  const abortRef = useRef<AbortController | null>(null);
  const handleEventRef = useRef<(event: AgentEvent) => void>(() => {});
  const agentStartTimeRef = useRef<number>(0);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    loadMessages(sessionId);
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
      if (durationIntervalRef.current) clearInterval(durationIntervalRef.current);
    };
  }, [sessionId]);

  const handleEvent = useCallback((event: AgentEvent) => {
    const { type, data } = event;

    switch (type) {
      case 'run.started':
        agentStartTimeRef.current = Date.now();
        setState(prev => ({
          ...prev,
          status: 'thinking',
          stepCount: 0,
          duration: 0,
          streamingText: '',
          activeTools: new Map(),
          error: undefined,
        }));
        durationIntervalRef.current = setInterval(() => {
          setState(prev => ({
            ...prev,
            duration: Math.floor((Date.now() - agentStartTimeRef.current) / 1000),
          }));
        }, 1000);
        break;

      case 'text.delta':
        setState(prev => ({
          ...prev,
          status: 'streaming',
          streamingText: prev.streamingText + (data.delta as string),
        }));
        break;

      case 'text.end':
        if (durationIntervalRef.current) clearInterval(durationIntervalRef.current);
        setState(prev => ({
          ...prev,
          status: prev.activeTools.size > 0 ? 'tool_call' : 'done',
          streamingText: '',
          messages: data.content ? [...prev.messages, {
            id: data.messageId as string || `msg-${Date.now()}`,
            sessionId,
            role: 'assistant',
            content: data.content as string,
            tokensInput: 0,
            tokensOutput: 0,
            createdAt: new Date().toISOString(),
          }] : prev.messages,
        }));
        break;

      case 'tool.started':
        setState(prev => {
          const next = new Map(prev.activeTools);
          next.set(data.toolCallId as string, {
            name: data.toolName as string,
            args: data.args,
            status: 'running',
            startTime: Date.now(),
          });
          return { ...prev, status: 'tool_call', activeTools: next };
        });
        break;

      case 'tool.output':
        setState(prev => {
          const next = new Map(prev.activeTools);
          const tool = next.get(data.toolCallId as string);
          if (tool) {
            tool.output = data.output as string;
            tool.status = 'output';
          }
          return { ...prev, activeTools: next };
        });
        break;

      case 'tool.completed':
        setState(prev => {
          const next = new Map(prev.activeTools);
          const tool = next.get(data.toolCallId as string);
          if (tool) {
            tool.status = 'completed';
            tool.result = data.result;
          }
          return { ...prev, activeTools: next };
        });
        break;

      case 'tool.failed':
        setState(prev => {
          const next = new Map(prev.activeTools);
          const tool = next.get(data.toolCallId as string);
          if (tool) {
            tool.status = 'failed';
            tool.output = data.error as string;
          }
          return { ...prev, activeTools: next };
        });
        break;

      case 'step.started':
        setState(prev => ({ ...prev, stepCount: data.step as number, status: 'thinking' }));
        break;

      case 'llm.thinking':
        setState(prev => ({ ...prev, status: 'thinking' }));
        break;

      case 'permission.required':
        setState(prev => ({
          ...prev,
          pendingPermission: {
            toolCallId: data.toolCallId as string,
            toolName: data.toolName as string,
            args: data.args,
          },
        }));
        break;

      case 'run.completed':
      case 'run.interrupted':
      case 'run.failed':
        if (durationIntervalRef.current) clearInterval(durationIntervalRef.current);
        if (abortRef.current) {
          abortRef.current.abort();
          abortRef.current = null;
        }
        setState(prev => ({
          ...prev,
          status: type === 'run.failed' ? 'error' : 'done',
          streamingText: '',
          activeTools: new Map(),
          error: type === 'run.failed' ? (data.error as string) : undefined,
        }));
        agentStartTimeRef.current = 0;
        break;
    }
  }, [sessionId]);

  useEffect(() => {
    handleEventRef.current = handleEvent;
  }, [handleEvent]);

  async function loadMessages(sid: string) {
    try {
      const msgs = await agentApi.getMessages(sid);
      setState(prev => ({ ...prev, messages: msgs }));
    } catch { /* ignore */ }
  }

  const sendMessage = useCallback(async (text: string, options?: { workspacePath?: string; model?: string; provider?: string }) => {
    if (!text.trim() || state.status === 'streaming' || state.status === 'thinking') return;

    const userMsg: AgentMessage = {
      id: `user-${Date.now()}`,
      sessionId,
      role: 'user',
      content: text,
      tokensInput: 0,
      tokensOutput: 0,
      createdAt: new Date().toISOString(),
    };

    setState(prev => ({
      ...prev,
      messages: [...prev.messages, userMsg],
      streamingText: '',
      activeTools: new Map(),
      status: 'thinking',
    }));

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const eventPromise = (async () => {
        for await (const event of agentApi.streamEvents(sessionId, controller.signal)) {
          handleEventRef.current(event);
        }
      })();

      await new Promise(r => setTimeout(r, 50));
      await agentApi.runAgent(sessionId, text, options);
      await eventPromise;
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setState(prev => ({
          ...prev,
          status: 'error',
          error: err instanceof Error ? err.message : 'Failed to start agent',
        }));
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [sessionId, state.status]);

  const interrupt = useCallback(async () => {
    try {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
      if (durationIntervalRef.current) clearInterval(durationIntervalRef.current);
      await agentApi.interrupt(sessionId);
      setState(prev => ({ ...prev, status: 'done', streamingText: '', activeTools: new Map() }));
    } catch { /* ignore */ }
  }, [sessionId]);

  const resolvePermission = useCallback(async (toolCallId: string, effect: 'allow' | 'deny') => {
    try {
      await agentApi.resolvePermission(toolCallId, effect);
      setState(prev => ({ ...prev, pendingPermission: undefined }));
    } catch { /* ignore */ }
  }, []);

  const clearError = useCallback(() => {
    setState(prev => ({ ...prev, error: undefined }));
  }, []);

  return (
    <AgentContext.Provider value={{
      state,
      sendMessage,
      interrupt,
      loadMessages,
      resolvePermission,
      clearError,
    }}>
      {children}
    </AgentContext.Provider>
  );
}

export function useAgent() {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error('useAgent must be used within AgentProvider');
  return ctx;
}

export type { AgentState, AgentStatus, ActiveTool, AgentContextValue };
