
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RedisService } from '../../common/services/redis.service';
import { ApiKeyCryptoService } from './api-key-crypto.service';
import {
  PROVIDER_BING,
  PROVIDER_BRAVE,
  PROVIDER_GEMINI,
  PROVIDER_GOOGLE,
  PROVIDER_NVIDIA,
  PROVIDER_OMNIROUTE,
  PROVIDER_OPENAI,
  PROVIDER_OPENCODE,
  PROVIDER_OPENROUTER,
  PROVIDER_TAVILY,
  PROVIDER_XAI,
  SUPPORTED_PROVIDERS,
  UserApiKey,
} from './user-api-key.entity';

const OPENROUTER_AUTH_URL = 'https://openrouter.ai/api/v1/auth/key';
const NVIDIA_CHAT_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
const XAI_MODELS_URL = 'https://api.x.ai/v1/models';
const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENCODE_MODELS_URL = 'https://opencode.ai/zen/v1/models';
const OMNIROUTE_MODELS_URL = 'http://localhost:20128/v1/models';

export interface UserKeySummary {
  provider: string;
  keyPrefix: string;
  last4: string;
  status: 'ok' | 'invalid';
  createdAt: string;
  updatedAt: string;
}

export interface OpenRouterKeyInfo {
  label: string;
  isFreeTier: boolean;
  limit: number | null;
  usage: number | null;
  remaining: number | null;
  rateLimited: boolean;
}

export interface SaveKeyResult extends UserKeySummary {
  info: OpenRouterKeyInfo | null;
}

@Injectable()
export class ApiKeysService {
  private readonly logger = new Logger(ApiKeysService.name);
  private readonly cacheTtl = Number(process.env.USER_API_KEY_CACHE_TTL || 86400);

  constructor(
    @InjectRepository(UserApiKey) private readonly keys: Repository<UserApiKey>,
    private readonly redis: RedisService,
    private readonly crypto: ApiKeyCryptoService,
  ) {}

  cacheKey(userId: string, provider: string): string {
    return `rag:user_key:${userId}:${provider}`;
  }

  /**
   * Fast per-request lookup of the user's key for a provider.
   * Redis-cached (plaintext) so chat/document pipelines don't hit the DB each time.
   */
  async getKey(userId: string, provider: string): Promise<string | null> {
    const cached = await this.redis.get(this.cacheKey(userId, provider));
    if (cached !== null) return cached || null;

    const row = await this.keys.findOne({ where: { userId, provider }, select: ['encryptedKey'] });
    if (!row) return null;

    const plain = this.crypto.decrypt(row.encryptedKey);
    if (plain === null) {
      await this.redis.del(this.cacheKey(userId, provider));
      return null;
    }
    await this.redis.set(this.cacheKey(userId, provider), plain, this.cacheTtl);
    return plain;
  }

  async listKeys(userId: string): Promise<UserKeySummary[]> {
    const rows = await this.keys.find({
      where: { userId },
      select: ['provider', 'keyPrefix', 'last4', 'encryptedKey', 'createdAt', 'updatedAt'],
    });
    return rows.map((row) => ({
      provider: row.provider,
      keyPrefix: row.keyPrefix,
      last4: row.last4,
      status: this.crypto.decrypt(row.encryptedKey) !== null ? 'ok' : 'invalid',
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async hasKey(userId: string, provider: string): Promise<boolean> {
    return (await this.getKey(userId, provider)) !== null;
  }

  async setKey(userId: string, provider: string, apiKey: string): Promise<SaveKeyResult> {
    if (!SUPPORTED_PROVIDERS.includes(provider as (typeof SUPPORTED_PROVIDERS)[number])) {
      throw new BadRequestException(`unsupported provider '${provider}'`);
    }
    if (!this.crypto.enabled) {
      throw new BadRequestException('server cannot store keys securely (API_KEY_ENCRYPTION_SECRET is not set)');
    }

    const normalized = apiKey.trim();
    this.assertKeyFormat(provider, normalized);

    const info = await this.validateKey(provider, normalized);

    const encrypted = this.crypto.encrypt(normalized);

    const existing = await this.keys.findOne({ where: { userId, provider } });
    const row = existing ?? this.keys.create({ userId, provider });
    row.encryptedKey = encrypted;
    row.keyPrefix = `${normalized.slice(0, 9)}…`;
    row.last4 = normalized.slice(-4);
    await this.keys.save(row);

    await this.redis.set(this.cacheKey(userId, provider), normalized, this.cacheTtl);

    return {
      provider,
      keyPrefix: row.keyPrefix,
      last4: row.last4,
      status: 'ok',
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      info,
    };
  }

  async removeKey(userId: string, provider: string): Promise<void> {
    await this.keys.delete({ userId, provider });
    await this.redis.del(this.cacheKey(userId, provider));
  }

  async getStoredKeyOrThrow(userId: string, provider: string): Promise<UserApiKey> {
    const row = await this.keys.findOne({ where: { userId, provider } });
    if (!row) throw new NotFoundException(`no ${provider} key saved`);
    return row;
  }

  private assertKeyFormat(provider: string, apiKey: string): void {
    if (!apiKey) throw new BadRequestException('API key is required');
    if (apiKey.length < 16) {
      throw new BadRequestException('that does not look like a valid API key (too short)');
    }
    if (provider === PROVIDER_OPENROUTER && !apiKey.startsWith('sk-or-v1-')) {
      throw new BadRequestException(
        'invalid OpenRouter key — it should start with "sk-or-v1-". Get one at openrouter.ai/keys',
      );
    }
    if (provider === PROVIDER_NVIDIA && !apiKey.startsWith('nvapi-')) {
      throw new BadRequestException(
        'invalid NVIDIA key — it should start with "nvapi-". Get one at build.nvidia.com',
      );
    }
    if (provider === PROVIDER_OPENAI && !/^sk-(proj-)?[A-Za-z0-9_-]{20,}$/.test(apiKey)) {
      throw new BadRequestException(
        'invalid OpenAI key — it should start with "sk-". Get one at platform.openai.com/api-keys',
      );
    }
    if (provider === PROVIDER_XAI && !/^xai-[A-Za-z0-9_-]{16,}$/.test(apiKey)) {
      throw new BadRequestException(
        'invalid xAI key — it should start with "xai-". Get one at console.x.ai',
      );
    }
    if (provider === PROVIDER_GEMINI && !/^[A-Za-z0-9._-]{16,128}$/.test(apiKey)) {
      throw new BadRequestException(
        'invalid Gemini key — it is an alphanumeric string (may include dots, dashes, underscores). Get one free at aistudio.google.com/apikey',
      );
    }
    if (provider === PROVIDER_OPENCODE && apiKey.trim().length < 8) {
      throw new BadRequestException(
        'invalid OpenCode Zen key — it is too short. Get one by signing in at opencode.ai/zen',
      );
    }
    if (provider === PROVIDER_TAVILY && !apiKey.startsWith('tvly-')) {
      throw new BadRequestException(
        'invalid Tavily key — it should start with "tvly-". Get one at app.tavily.com',
      );
    }
    if (provider === PROVIDER_BRAVE && !apiKey.startsWith('BSA')) {
      throw new BadRequestException(
        'invalid Brave key — it should start with "BSA". Get one at brave.com/search/api/',
      );
    }
    if (provider === PROVIDER_GOOGLE && !/^[A-Za-z0-9._-]{16,128}$/.test(apiKey)) {
      throw new BadRequestException(
        'invalid Google key — it is an alphanumeric string. Get one at console.cloud.google.com',
      );
    }
    if (provider === PROVIDER_BING && !/^[A-Za-z0-9]{24,40}$/.test(apiKey)) {
      throw new BadRequestException(
        'invalid Bing key — it is a 32-character string. Get one at azure.microsoft.com',
      );
    }
    if (provider === PROVIDER_OMNIROUTE) {
      // OmniRoute gateway keys (created in its "API Key / Endpoints" page).
      if (apiKey.length < 16) {
        throw new BadRequestException(
          'invalid OmniRoute key — it is too short. Create one at http://localhost:20128 → API Key / Endpoints',
        );
      }
    }
  }

  /**
   * Live-checks the key with its provider so we can fail fast with a friendly
   * message instead of surfacing an obscure 401 during a chat/document job.
   * Web search providers are NOT probed live — every call burns a paid search
   * credit (Tavily's free tier is only ~1k searches/month). Their keys are
   * validated lazily at search time and saved with `info: null`.
   */
  async validateKey(provider: string, apiKey: string): Promise<OpenRouterKeyInfo | null> {
    if (provider === PROVIDER_OPENROUTER) {
      return this.validateOpenRouterKey(apiKey);
    }
    if (provider === PROVIDER_NVIDIA) {
      return this.validateNvidiaKey(apiKey);
    }
    if (provider === PROVIDER_OPENAI) {
      return this.validateOpenAiCompatKey(OPENAI_MODELS_URL, apiKey, 'OpenAI');
    }
    if (provider === PROVIDER_XAI) {
      return this.validateOpenAiCompatKey(XAI_MODELS_URL, apiKey, 'xAI');
    }
    if (provider === PROVIDER_GEMINI) {
      return this.validateGeminiKey(apiKey);
    }
    if (provider === PROVIDER_OPENCODE) {
      return this.validateOpenAiCompatKey(OPENCODE_MODELS_URL, apiKey, 'OpenCode Zen');
    }
    if (provider === PROVIDER_OMNIROUTE) {
      return this.validateOpenAiCompatKey(OMNIROUTE_MODELS_URL, apiKey, 'OmniRoute');
    }
    return null;
  }

  /** Live-check an OpenAI-compatible provider key against its /v1/models feed. */
  private async validateOpenAiCompatKey(
    url: string,
    apiKey: string,
    label: string,
  ): Promise<OpenRouterKeyInfo | null> {
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` } });
      if (!res.ok) return null;
      return { label, isFreeTier: false, limit: null, usage: null, remaining: null, rateLimited: false };
    } catch {
      return null;
    }
  }

  private async validateGeminiKey(apiKey: string): Promise<OpenRouterKeyInfo | null> {
    try {
      const res = await fetch(`${GEMINI_MODELS_URL}?key=${encodeURIComponent(apiKey)}`);
      if (!res.ok) return null;
      return { label: 'Google AI Studio', isFreeTier: true, limit: null, usage: null, remaining: null, rateLimited: false };
    } catch {
      return null;
    }
  }

  private async validateOpenRouterKey(apiKey: string): Promise<OpenRouterKeyInfo | null> {
    try {
      const res = await fetch(OPENROUTER_AUTH_URL, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) {
        const body = (await res.json()) as {
          data?: { label?: string; is_free_tier?: boolean; limit?: number | null; usage?: number | null };
        };
        const data = body.data ?? {};
        const limit = data.limit ?? null;
        const usage = data.usage ?? null;
        return {
          label: data.label ?? '',
          isFreeTier: !!data.is_free_tier,
          limit,
          usage,
          remaining: limit != null && usage != null ? Math.max(0, limit - usage) : null,
          rateLimited: limit != null && usage != null && usage >= limit,
        };
      }
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      const msg = body.error?.message || '';
      if (res.status === 401) {
        throw new BadRequestException('invalid OpenRouter key — check it at openrouter.ai/keys');
      }
      if (res.status === 402) {
        throw new BadRequestException('this OpenRouter key has no remaining credits');
      }
      if (res.status === 429) {
        throw new BadRequestException('OpenRouter is rate limiting this key — try again shortly');
      }
      throw new BadRequestException(
        `OpenRouter rejected the key (${res.status})${msg ? `: ${msg}` : ''}`,
      );
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.warn(`key validation request failed: ${err}`);
      // Network hiccup — don't block saving; the key is checked again lazily at use-time.
      return null;
    }
  }

  private async validateNvidiaKey(apiKey: string): Promise<OpenRouterKeyInfo | null> {
    try {
      const res = await fetch(NVIDIA_CHAT_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'nvidia/nemotron-3-super-120b-a12b',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
      });
      if (res.ok) {
        return {
          label: 'NVIDIA NIM',
          isFreeTier: false,
          limit: null,
          usage: null,
          remaining: null,
          rateLimited: false,
        };
      }
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string } | string;
      };
      const msg = typeof body.error === 'string' ? body.error : body.error?.message || '';
      if (res.status === 401) {
        throw new BadRequestException('invalid NVIDIA key — check it at build.nvidia.com');
      }
      if (res.status === 402) {
        throw new BadRequestException('this NVIDIA key has no remaining credits');
      }
      if (res.status === 429) {
        throw new BadRequestException('NVIDIA is rate limiting this key — try again shortly');
      }
      throw new BadRequestException(
        `NVIDIA rejected the key (${res.status})${msg ? `: ${msg}` : ''}`,
      );
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.warn(`nvidia key validation request failed: ${err}`);
      return null;
    }
  }
}
