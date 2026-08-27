import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ApiKeysService } from '../keys/api-keys.service';
import { PlaygroundRetrieveDto } from './dto/playground-retrieve.dto';

@Injectable()
export class PlaygroundService {
  private readonly logger = new Logger(PlaygroundService.name);
  private readonly ragUrl = process.env.RAG_SERVICE_URL || 'http://localhost:8000';

  constructor(private readonly keys: ApiKeysService) {}

  /**
   * Retrieval-only proxy to rag-service. The user's own provider key (if any)
   * wins over the server default, mirroring the chat flow.
   */
  async retrieve(userId: string, dto: PlaygroundRetrieveDto): Promise<unknown> {
    const CLOUD_PROVIDERS = ['openrouter', 'nvidia'];
    let apiKey: string | null = null;
    if (dto.provider && CLOUD_PROVIDERS.includes(dto.provider)) {
      try {
        apiKey = (await this.keys.getKey(userId, dto.provider)) || null;
      } catch (err) {
        this.logger.warn(`failed to resolve user key for ${userId}: ${err}`);
        apiKey = null;
      }
    }

    let upstream: Response;
    try {
      upstream = await fetch(`${this.ragUrl}/api/v1/retrieve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: dto.message,
          user_id: userId,
          provider: dto.provider,
          model: dto.model,
          mode: dto.mode,
          document_ids: dto.documentIds ?? [],
          api_key: apiKey,
        }),
      });
    } catch (err) {
      this.logger.error(`rag-service /retrieve call failed: ${(err as Error).message}`);
      throw new BadGatewayException('retrieval service unavailable');
    }

    if (!upstream.ok) {
      const detail = (await upstream.text().catch(() => '')).slice(0, 300);
      this.logger.error(`rag-service /retrieve responded with ${upstream.status}: ${detail}`);
      throw new BadGatewayException(
        `retrieval service responded with ${upstream.status}${detail ? `: ${detail}` : ''}`,
      );
    }
    return upstream.json();
  }
}
