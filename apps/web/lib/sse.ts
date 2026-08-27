import type { ChatStreamEvent } from '@rag/contracts';

/** Parse a browser fetch ReadableStream of SSE data into events. */
export async function* streamSse(
  response: Response,
  abortSignal?: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => '');
    throw new Error(`request failed (${response.status}): ${body}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // The desktop backend (sse_starlette) emits CRLF event separators; the
    // cloud gateway emits bare LF. Normalize so both parse identically.
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = parseSseBlock(block);
      if (event) yield event;
    }
  }
  // Flush a trailing block that arrived without a final blank line.
  const event = parseSseBlock(buffer.trimEnd());
  if (event) yield event;
}

function parseSseBlock(block: string): ChatStreamEvent | null {
  let eventType = 'message';
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) eventType = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return null;
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    return { type: eventType, ...parsed } as ChatStreamEvent;
  } catch {
    return null;
  }
}
