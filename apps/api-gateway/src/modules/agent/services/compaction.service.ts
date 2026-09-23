import { Injectable, Logger } from '@nestjs/common';
import { AgentMessageService } from './agent-message.service';
import { AgentSessionService } from './agent-session.service';
import { ApiKeysService } from '../../keys/api-keys.service';
import {
  CHARS_PER_TOKEN,
  COMPACTION_THRESHOLD,
  KEEP_RECENT_MESSAGES,
  LLMMessage,
  ContextSnapshot,
  estimateTokens,
  resolveTokenBudget,
} from './run-context';

interface CompactionResult {
  summary: string;
  recentMessages: string[];
  tokensSaved: number;
}

export interface CompactRunContextResult {
  summary: string;
  tokensSaved: number;
  /** The messages to keep (recent tail, cut at a pair-safe boundary). */
  kept: LLMMessage[];
  /**
   * Index into the caller's message array marking the first KEPT message.
   * The caller maps this onto persisted-row coverage (leading system/snapshot
   * entries are synthetic and must not be counted as rows).
   */
  cutIndex: number;
}

@Injectable()
export class ContextCompactionService {
  private readonly logger = new Logger(ContextCompactionService.name);

  constructor(
    private readonly messageService: AgentMessageService,
    private readonly sessionService: AgentSessionService,
    private readonly apiKeyService: ApiKeysService,
  ) {}

  async shouldCompact(sessionId: string): Promise<boolean> {
    const messages = await this.messageService.findBySession(sessionId, 500);
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = Math.ceil(totalChars / CHARS_PER_TOKEN);
    const threshold = resolveTokenBudget() * COMPACTION_THRESHOLD;

    this.logger.debug(`Session ${sessionId}: ~${estimatedTokens} tokens (threshold: ${threshold})`);
    return estimatedTokens > threshold;
  }

  /**
   * Manual/controller-triggered compaction for a whole session (DB-based).
   * Writes the checkpoint marker AND persists a ContextSnapshot so future
   * runs actually start from SUMMARY + RECENT instead of replaying history.
   */
  async compact(sessionId: string, provider?: string, model?: string): Promise<CompactionResult | null> {
    const messages = await this.messageService.findBySession(sessionId, 500);
    if (messages.length < 6) return null;

    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = Math.ceil(totalChars / CHARS_PER_TOKEN);

    if (estimatedTokens <= resolveTokenBudget(provider, model) * COMPACTION_THRESHOLD) {
      return null;
    }

    this.logger.log(`Compacting session ${sessionId}: ~${estimatedTokens} tokens`);

    const recentMessages = messages.slice(-KEEP_RECENT_MESSAGES);
    const messagesToCompact = messages.slice(0, -KEEP_RECENT_MESSAGES);

    const summary = await this.summarizeMessages(
      messagesToCompact.map((m) => ({
        role: m.role,
        content: m.content,
        toolNames: (m.toolCalls || []).map((tc) => tc.toolName),
      })),
      provider,
      model,
    );

    await this.writeCheckpointMarker(sessionId, summary);

    const compactedChars = messagesToCompact.reduce((sum, m) => sum + m.content.length, 0);
    const tokensSaved = Math.ceil(compactedChars / CHARS_PER_TOKEN);

    // Persist the snapshot so the next run() starts from SUMMARY + RECENT
    // instead of replaying the compacted rows. Coverage equals the number of
    // summarized rows — NOT the total row count (the recent tail is not in
    // the summary and must still be replayed by future runs).
    try {
      const session = await this.sessionService.findOne(sessionId);
      if (session) {
        const prev = (session.contextSnapshot || {}) as Partial<ContextSnapshot>;
        const merged: ContextSnapshot = {
          task: prev.task || '',
          summary: prev.summary ? `${prev.summary}\n\n---\n\n${summary}` : summary,
          coveredMessages: Math.max(prev.coveredMessages || 0, messagesToCompact.length),
          filesRead: prev.filesRead || [],
          filesModified: prev.filesModified || [],
          decisions: prev.decisions || [],
          errors: prev.errors || [],
          plan: prev.plan || [],
          activeSubContexts: prev.activeSubContexts || [],
          activeContexts: prev.activeContexts || [],
        };
        await this.sessionService.saveContextSnapshot(sessionId, merged as unknown as Record<string, unknown>);
      }
    } catch (err) {
      this.logger.warn(`Failed to persist snapshot for ${sessionId}: ${err}`);
    }

    this.logger.log(`Compaction complete for ${sessionId}: saved ~${tokensSaved} tokens`);

    return {
      summary,
      recentMessages: recentMessages.map((m) => m.content),
      tokensSaved,
    };
  }

  /**
   * Compacts the LIVE in-memory run conversation. Pure with respect to the
   * caller's message array — returns the kept tail; the runner rewrites its
   * RunContext.messages and merges the returned summary into the session
   * snapshot. This is what makes compaction real: the old turns are replaced
   * by the summary in every subsequent LLM call of this run.
   */
  async compactRunContext(opts: {
    sessionId: string;
    messages: LLMMessage[];
    provider?: string;
    model?: string;
    userId?: string;
  }): Promise<CompactRunContextResult | null> {
    const { sessionId, messages, provider, model, userId } = opts;

    const estimated = estimateTokens(messages);
    if (estimated <= resolveTokenBudget(provider, model) * COMPACTION_THRESHOLD) return null;
    if (messages.length < KEEP_RECENT_MESSAGES + 4) return null;

    const cut = findSafeCutIndex(messages, KEEP_RECENT_MESSAGES);
    if (cut <= 1) return null; // nothing safely compactable

    const toCompact = messages.slice(1, cut); // skip leading system prompt
    const kept = [...messages.slice(0, 1), ...messages.slice(cut)];

    this.logger.log(`Compacting run context for ${sessionId}: ~${estimated} tokens → summarizing ${toCompact.length} messages`);

    const summary = await this.summarizeMessages(
      toCompact.map((m) => ({
        role: m.role,
        content: m.content ?? '',
        toolNames: (m.tool_calls || []).map((tc) => tc.function.name),
      })),
      provider,
      model,
      userId,
    );

    await this.writeCheckpointMarker(sessionId, summary);

    const compactedChars = toCompact.reduce(
      (sum, m) =>
        sum +
        (m.content?.length ?? 0) +
        (m.tool_calls ? m.tool_calls.reduce((s, tc) => s + tc.function.arguments.length, 0) : 0),
      0,
    );

    return {
      summary,
      tokensSaved: Math.ceil(compactedChars / CHARS_PER_TOKEN),
      kept,
      cutIndex: cut,
    };
  }

  /** Writes the visible `<conversation-checkpoint>` marker row (UI transparency). */
  private async writeCheckpointMarker(sessionId: string, summary: string): Promise<void> {
    try {
      await this.messageService.create(
        sessionId,
        'system',
        `<conversation-checkpoint>\n## Conversation Summary\n${summary}\n\nOlder messages were compacted into this summary and are excluded from the agent's context.\n</conversation-checkpoint>`,
        { tokensInput: 0, tokensOutput: 0 },
      );
    } catch (err) {
      this.logger.warn(`Failed to write compaction marker for ${sessionId}: ${err}`);
    }
  }

  private async summarizeMessages(
    messages: Array<{ role: string; content: string; toolNames?: string[] }>,
    provider?: string,
    model?: string,
    userId?: string,
  ): Promise<string> {
    const conversation = messages
      .map((m) => {
        const role = m.role.toUpperCase();
        let content = m.content;
        if (m.toolNames && m.toolNames.length > 0) {
          content += `\n${m.toolNames.map((n) => `[Called: ${n}]`).join(' ')}`;
        }
        return `${role}: ${content.slice(0, 1000)}`;
      })
      .join('\n\n');

    const prompt = `You are a conversation summarizer. Create a structured summary of the following coding conversation. Focus on:

1. **Objective**: What the user asked for
2. **Files explored**: Which files were read/mentioned
3. **Files changed**: What was modified
4. **Key findings**: Root causes, bugs found, patterns identified
5. **Current state**: Where the work stopped, what was completed vs pending
6. **Important discoveries**: Any gotchas, constraints, or requirements
7. **Next steps**: What should happen next

Be concise but preserve critical details. A developer reading this summary should be able to continue the work without re-reading the full conversation.

CONVERSATION TO SUMMARIZE:
${conversation}

SUMMARY:`;

    try {
      const baseUrl = process.env.LLM_BASE_URL || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
      const modelName = model || process.env.AGENT_MODEL || 'qwen3:8b';
      const apiKey = process.env.LLM_API_KEY || '';

      let url = baseUrl;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };

      // Resolve API key: user's stored key first, then env var fallback.
      const userKey = userId ? await this.apiKeyService.getKey(userId, provider || 'ollama') : undefined;

      if (provider === 'nvidia') {
        const nvidiaKey = userKey || process.env.NVIDIA_API_KEY || '';
        if (nvidiaKey) headers['Authorization'] = `Bearer ${nvidiaKey}`;
        url = `https://integrate.api.nvidia.com/v1/chat/completions`;
      } else if (provider === 'openai') {
        const openaiKey = userKey || process.env.OPENAI_API_KEY || apiKey;
        if (openaiKey) headers['Authorization'] = `Bearer ${openaiKey}`;
        url = `https://api.openai.com/v1/chat/completions`;
      } else if (provider === 'openrouter') {
        const orKey = userKey || process.env.OPENROUTER_API_KEY || apiKey;
        if (orKey) headers['Authorization'] = `Bearer ${orKey}`;
        url = `https://openrouter.ai/api/v1/chat/completions`;
      } else if (provider === 'xai') {
        const xaiKey = userKey || process.env.XAI_API_KEY || '';
        if (xaiKey) headers['Authorization'] = `Bearer ${xaiKey}`;
        url = `https://api.x.ai/v1/chat/completions`;
      } else if (provider === 'gemini') {
        const geminiKey = userKey || process.env.GEMINI_API_KEY || '';
        if (geminiKey) headers['Authorization'] = `Bearer ${geminiKey}`;
        url = `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`;
      } else if (provider === 'opencode') {
        const ocKey = userKey || process.env.OPENCODE_API_KEY || apiKey;
        if (ocKey) headers['Authorization'] = `Bearer ${ocKey}`;
        url = `https://opencode.ai/zen/v1/chat/completions`;
      } else if (provider === 'ollama' || !provider) {
        url = `${baseUrl}/api/chat`;
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const body: Record<string, unknown> = {
        model: modelName,
        messages: [
          {
            role: 'system',
            content: 'You are a conversation summarizer for a coding agent. Output only the summary, no preamble.',
          },
          { role: 'user', content: prompt },
        ],
        stream: false,
      };

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });

      if (!response.ok) {
        throw new Error(`LLM API error: ${response.status}`);
      }

      const data = await response.json() as any;

      if (provider === 'ollama' || !provider) {
        return data.message?.content || this.fallbackSummary(messages as any);
      }

      return data.choices?.[0]?.message?.content || this.fallbackSummary(messages as any);
    } catch (err) {
      this.logger.warn(`LLM summary failed, using fallback: ${err}`);
      return this.fallbackSummary(messages as any);
    }
  }

  private fallbackSummary(messages: Array<{ role: string; content: string }>): string {
    const roles = new Set(messages.map((m) => m.role));
    const userMessages = messages.filter((m) => m.role === 'user');
    const lastUserMsg = userMessages[userMessages.length - 1]?.content.slice(0, 500) || 'unknown';

    const fileMentions = new Set<string>();
    for (const msg of messages) {
      const matches = msg.content.match(/(?:read|write|edit|patch)\w*\s+([^\s\n]+)/gi);
      if (matches) {
        for (const match of matches) {
          const file = match.split(/\s+/).pop();
          if (file) fileMentions.add(file);
        }
      }
    }

    return `## Auto-Compressed Summary
- **Participants**: ${Array.from(roles).join(', ')}
- **Messages compressed**: ${messages.length}
- **Files mentioned**: ${fileMentions.size > 0 ? Array.from(fileMentions).join(', ') : 'none detected'}
- **Last request**: ${lastUserMsg}
- **Compression**: Automatic (context window > 70% full)`;
  }
}

/**
 * Returns an index `i` such that slicing [i..] keeps at least `keep` messages
 * and never separates an assistant tool_calls message from its tool results.
 * Walks BACKWARD from the desired cut to the nearest safe boundary.
 */
export function findSafeCutIndex(messages: LLMMessage[], keep: number): number {
  let cut = Math.max(1, messages.length - keep);
  while (cut > 1 && isUnsafeCut(messages, cut)) cut--;
  return cut;
}

/** A cut at `i` is unsafe if it orphans tool results or their assistant call. */
function isUnsafeCut(messages: LLMMessage[], i: number): boolean {
  // Never start the tail on a tool result (its assistant would be dropped).
  if (messages[i]?.role === 'tool') return true;
  // Never leave an assistant-with-tool_calls as the final old message —
  // its results would land in the kept tail, splitting the pair.
  const prev = messages[i - 1];
  if (prev?.role === 'assistant' && prev.tool_calls?.length) return true;
  return false;
}
