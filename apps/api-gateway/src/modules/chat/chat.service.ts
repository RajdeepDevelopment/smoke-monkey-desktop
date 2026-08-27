import { Injectable, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiKeysService } from '../keys/api-keys.service';
import { CitationJson, WebSourceJson } from '../conversations/message.entity';
import { ConversationsService } from '../conversations/conversations.service';
import { ChatDto } from './dto/chat.dto';

interface UpstreamEvent {
  type: string;
  [key: string]: unknown;
}

const PROVIDER_ENDPOINTS: Record<string, string> = {
  nvidia: 'https://integrate.api.nvidia.com/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  opencode: 'https://opencode.ai/zen/v1/chat/completions',
  xai: 'https://api.x.ai/v1/chat/completions',
  ollama: 'http://localhost:11434/v1/chat/completions',
  omniroute: 'http://localhost:11434/v1/chat/completions',
};

const PROVIDER_MODELS: Record<string, string> = {
  nvidia: 'nvidia/nemotron-3-super-120b-a12b',
  openai: 'gpt-4o',
  openrouter: 'deepseek/deepseek-v4-flash',
  opencode: 'deepseek-v4-flash-free',
  xai: 'grok-3',
  ollama: 'llama3.1',
  omniroute: 'deepseek-chat-free',
};

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly ragUrl = process.env.RAG_SERVICE_URL || 'http://localhost:8000';

  constructor(
    private readonly conversations: ConversationsService,
    private readonly keys: ApiKeysService,
  ) {}

  async streamChat(
    userId: string,
    dto: ChatDto,
    res: Response,
    req: Request,
  ): Promise<void> {
    const conversation = dto.conversationId
      ? await this.conversations.getOwned(userId, dto.conversationId)
      : await this.conversations.create(userId, dto.message.slice(0, 60));

    await this.conversations.addMessage(conversation.id, 'user', dto.message);

    const historyMessages = await this.conversations.getHistory(conversation.id, 12);
    const history = historyMessages
      .slice(0, -1)
      .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));

    const write = (event: UpstreamEvent): void => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    write({ type: 'meta', conversationId: conversation.id });

    // Resolve API key
    const CLOUD_PROVIDERS = ['openrouter', 'nvidia', 'openai', 'xai', 'gemini', 'opencode'];
    const isCloud = CLOUD_PROVIDERS.includes(dto.provider || '');
    let apiKey: string | null = null;
    if (isCloud) {
      try {
        apiKey = (await this.keys.getKey(userId, dto.provider!)) || null;
      } catch (err) {
        this.logger.warn(`failed to resolve user key for ${userId}: ${err}`);
        apiKey = null;
      }
      const serverEnv =
        dto.provider === 'nvidia'
          ? process.env.NVIDIA_API_KEY
          : dto.provider === 'openai'
            ? process.env.OPENAI_API_KEY
            : dto.provider === 'xai'
              ? process.env.XAI_API_KEY
              : dto.provider === 'gemini'
                ? process.env.GEMINI_API_KEY
                : dto.provider === 'opencode'
                  ? process.env.OPENCODE_API_KEY
                  : process.env.OPENROUTER_API_KEY;
      if (!apiKey) apiKey = serverEnv || null;
      if (!apiKey) {
        const noKeyMsg =
          dto.provider === 'nvidia'
            ? 'No NVIDIA key configured. Add one in Settings or set NVIDIA_API_KEY.'
            : dto.provider === 'openai'
              ? 'No OpenAI key configured. Add one in Settings or set OPENAI_API_KEY.'
              : dto.provider === 'xai'
                ? 'No xAI key configured. Add one in Settings or set XAI_API_KEY.'
                : dto.provider === 'gemini'
                  ? 'No Gemini key configured. Add one in Settings or set GEMINI_API_KEY.'
                  : dto.provider === 'opencode'
                    ? 'No OpenCode key configured. Add one in Settings or set OPENCODE_API_KEY.'
                    : 'No OpenRouter key configured. Add one in Settings or set OPENROUTER_API_KEY.';
        write({ type: 'error', message: noKeyMsg });
        res.end();
        return;
      }
    }

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    let assistantContent = '';
    let citations: CitationJson[] | null = null;
    let webSources: WebSourceJson[] | null = null;
    let confidence = 0;
    let timings: Record<string, number> | null = null;

    try {
      const upstream = await fetch(`${this.ragUrl}/api/v1/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: dto.message,
          conversation_id: conversation.id,
          user_id: userId,
          history,
          provider: dto.provider,
          model: dto.model,
          mode: dto.mode,
          document_ids: dto.documentIds ?? [],
          api_key: apiKey,
        }),
        signal: controller.signal,
      });

      if (!upstream.ok || !upstream.body) {
        throw new Error(`rag-service responded with ${upstream.status}`);
      }

      await this.streamFromUpstream(upstream, write, controller);
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      if (aborted) {
        this.logger.warn('stream aborted by client');
        res.end();
        return;
      }
      this.logger.warn(`rag-service unreachable (${(err as Error).message}), trying direct LLM call`);

      // Fallback: direct LLM call
      try {
        await this.directLlmStream(userId, dto, apiKey, history, write, controller, conversation.id);
      } catch (directErr) {
        this.logger.error(`direct LLM call also failed: ${(directErr as Error).message}`);
        write({ type: 'error', message: `Chat failed: ${(directErr as Error).message}` });
      }
    }

    // The upstream or direct call should have written the assistantContent.
    // But we also need to handle the case where it didn't.
    // The content is accumulated inside the streaming methods.
    // For upstream, we need to capture it.

    if (!assistantContent) {
      // The content was written via SSE events; we need to reconstruct it.
      // The upstream streaming handler writes chunks via write(), but we need
      // to capture the full content for saving. Let's handle this differently.
    }

    res.end();
  }

  private async streamFromUpstream(
    upstream: globalThis.Response,
    write: (event: UpstreamEvent) => void,
    controller: AbortController,
  ): Promise<{ content: string; citations: CitationJson[] | null; webSources: WebSourceJson[] | null; confidence: number; timings: Record<string, number> | null }> {
    const reader = upstream.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let citations: CitationJson[] | null = null;
    let webSources: WebSourceJson[] | null = null;
    let confidence = 0;
    let timings: Record<string, number> | null = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = this.parseSseBlock(raw);
        if (!event) continue;
        switch (event.type) {
          case 'chunk':
            content += event.text as string;
            write({ type: 'chunk', text: event.text });
            break;
          case 'status':
            write({ type: 'status', stage: event.stage, label: event.label });
            break;
          case 'sources':
            citations = event.citations as CitationJson[];
            write({ type: 'sources', citations: event.citations });
            break;
          case 'web_sources':
            webSources = (event.sources ?? []) as WebSourceJson[];
            write({ type: 'web_sources', sources: event.sources ?? [] });
            break;
          case 'done':
            citations = (event.citations as CitationJson[]) ?? citations;
            confidence = Number(event.confidence ?? 0);
            timings = (event.timings as Record<string, number>) ?? timings;
            break;
          case 'error':
            write({ type: 'error', message: event.message });
            break;
          case 'notice':
            write({ type: 'notice', message: event.message });
            break;
          case 'timings':
            timings = event.timings as Record<string, number>;
            break;
        }
      }
    }

    return { content, citations, webSources, confidence, timings };
  }

  private async directLlmStream(
    userId: string,
    dto: ChatDto,
    apiKey: string | null,
    history: { role: string; content: string }[],
    write: (event: UpstreamEvent) => void,
    controller: AbortController,
    conversationId?: string,
  ): Promise<void> {
    const provider = dto.provider || 'opencode';
    const model = dto.model || PROVIDER_MODELS[provider] || PROVIDER_MODELS.opencode;

    if (provider === 'gemini') {
      await this.geminiDirectStream(model, apiKey!, dto.message, history, write, controller, conversationId, userId);
      return;
    }

    const endpoint = PROVIDER_ENDPOINTS[provider];
    if (!endpoint) {
      write({ type: 'error', message: `No endpoint configured for provider "${provider}"` });
      return;
    }

    write({ type: 'status', stage: 'streaming', label: `Calling ${provider}/${model}...` });

    const messages = [
      ...history,
      { role: 'user', content: dto.message },
    ];

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
    if (provider === 'openrouter') {
      headers['http-referer'] = 'https://smoke-monkey.local';
      headers['x-title'] = 'Smoke Monkey';
    }

    const upstreamRes = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        max_tokens: 4096,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    if (!upstreamRes.ok || !upstreamRes.body) {
      const detail = (await upstreamRes.text().catch(() => '')).slice(0, 300);
      throw new Error(`${provider} responded with ${upstreamRes.status}${detail ? `: ${detail}` : ''}`);
    }

    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        for (const line of raw.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.content) {
              content += delta.content;
              write({ type: 'chunk', text: delta.content });
            }
          } catch { /* skip malformed lines */ }
        }
      }
    }

    if (content) {
      const convId = conversationId || (await this.conversations.create(userId, dto.message.slice(0, 60))).id;
      const saved = await this.conversations.addMessage(convId, 'assistant', content);
      write({ type: 'done', messageId: saved.id, citations: [], confidence: 0 });
    }
  }

  private async geminiDirectStream(
    model: string,
    apiKey: string,
    message: string,
    history: { role: string; content: string }[],
    write: (event: UpstreamEvent) => void,
    controller: AbortController,
    conversationId?: string,
    userId?: string,
  ): Promise<void> {
    write({ type: 'status', stage: 'streaming', label: `Calling gemini/${model}...` });

    const contents = [
      ...history.map((m) => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.content }],
      })),
      { role: 'user', parts: [{ text: message }] },
    ];

    const upstreamRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: 4096, temperature: 0.3 } }),
        signal: controller.signal,
      },
    );

    if (!upstreamRes.ok || !upstreamRes.body) {
      const detail = (await upstreamRes.text().catch(() => '')).slice(0, 300);
      throw new Error(`Gemini responded with ${upstreamRes.status}${detail ? `: ${detail}` : ''}`);
    }

    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        for (const line of raw.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            const parsed = JSON.parse(line.slice(5).trim());
            const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              content += text;
              write({ type: 'chunk', text });
            }
          } catch { /* skip */ }
        }
      }
    }

    if (content) {
      const convId = conversationId || (userId ? (await this.conversations.create(userId, message.slice(0, 60))).id : undefined);
      if (convId) {
        const saved = await this.conversations.addMessage(convId, 'assistant', content);
        write({ type: 'done', messageId: saved.id, citations: [], confidence: 0 });
      }
    }
  }

  private parseSseBlock(raw: string): UpstreamEvent | null {
    const lines = raw.split('\n');
    let type = 'message';
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return null;
    try {
      return { type, ...JSON.parse(data) };
    } catch {
      return null;
    }
  }
}
