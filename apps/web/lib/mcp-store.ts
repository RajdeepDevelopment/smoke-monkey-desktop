'use client';

/**
 * Shared, live MCP server store.
 *
 * Components used to each hold their own snapshot of `/api/mcp` (fetched on
 * mount), so a server added in one component never appeared in another until
 * a route remount. This module keeps one canonical cache + a subscription set;
 * any mutation calls `refreshMcpList()` which refetches and notifies every
 * subscriber, so the MCP page, the agent chat quick-add panel, and any other
 * listener update immediately.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { api } from './api';

export interface McpServerLite {
  id: string;
  name: string;
  description: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  url: string | null;
  oauthConnected?: boolean;
  oauthExpiresAt?: number | null;
  enabled: boolean;
  icon: string | null;
  category: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

type Listener = () => void;

let cache: McpServerLite[] | null = null;
let loading = false;
const listeners = new Set<Listener>();

const EMPTY: McpServerLite[] = [];

async function load(): Promise<McpServerLite[]> {
  loading = true;
  try {
    const res = await api.listMcpServers();
    cache = (res.servers ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      transport: s.transport,
      command: s.command,
      args: s.args ?? [],
      url: s.url ?? null,
      oauthConnected: s.oauthConnected,
      oauthExpiresAt: s.oauthExpiresAt ?? null,
      enabled: s.enabled,
      icon: s.icon ?? null,
      category: s.category ?? null,
      tags: s.tags ?? [],
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
  } catch {
    // Keep the previous snapshot on failure (never clobber a good cache).
  } finally {
    loading = false;
    for (const listener of listeners) listener();
  }
  return cache ?? [];
}

function getSnapshot(): McpServerLite[] {
  return cache ?? EMPTY;
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (!loading && cache === null) {
    void load();
  }
  return () => {
    listeners.delete(listener);
  };
}

/** Refetches the list now and notifies all subscribers. Returns the new list. */
export function refreshMcpList(): Promise<McpServerLite[]> {
  return load();
}

/** Current cached list, or null when it has never loaded (for non-hook reads). */
export function peekMcpList(): McpServerLite[] | null {
  return cache;
}

/** React hook — mirrors the shared MCP list live across all subscribers. */
export function useMcpList(): {
  servers: McpServerLite[];
  loading: boolean;
  refresh: () => Promise<McpServerLite[]>;
} {
  const servers = useSyncExternalStore(subscribe, getSnapshot);
  const refresh = useCallback(() => refreshMcpList(), []);
  return { servers, loading: cache === null, refresh };
}