import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiKeyCryptoService } from '../keys/api-key-crypto.service';
import { SECRET_HUGGING_FACE, UserSecret } from './user-secret.entity';
import { SECRET_NAME_RE } from './dto/secrets.dto';

export interface SecretSummary {
  name: string;
  keyPrefix: string;
  last4: string;
  status: 'ok' | 'invalid';
  billingTier?: 'free' | 'paid' | null;
  createdAt: string;
  updatedAt: string;
}

export interface HuggingFaceStatusInfo {
  configured: boolean;
  status: 'ok' | 'invalid';
  /** The environment variable the agent runtime is told to read the token from. */
  envName: string;
  /** Account billing tier detected from whoami at save time. */
  tier?: 'free' | 'paid' | null;
  /** Detected account metadata (canPay, isPro, billingMode, periodEnd, name). */
  billingMeta?: Record<string, unknown> | null;
}

/** whoami fields used to classify a token as free (Basic) vs paid (Pro/credits). */
export interface HuggingFaceWhoami extends Record<string, unknown> {
  name?: string;
  canPay?: boolean;
  isPro?: boolean;
  billingMode?: string;
  periodEnd?: number;
}

const HUGGING_FACE_ENV = 'HUGGING_FACE_TOKEN';
const HUGGING_FACE_WHOAMI_URL = 'https://huggingface.co/api/whoami-v2';

/**
 * Secret Manager: named, per-user secrets (encrypted at rest with the same
 * AES-256-GCM scheme as provider keys). The agent reaches them through the
 * secret_manager tool, which always requires explicit user approval (see the
 * always-ask permission rule in agent-permission.service.ts).
 *
 * The special `huggingface` secret drives both the Hugging Face settings UI
 * (save → whoami-v2 validation → valid/invalid status chip) and the dynamic
 * system-prompt injection (prompt is only added when the token is configured).
 */
@Injectable()
export class SecretsService {
  private readonly logger = new Logger(SecretsService.name);

  constructor(
    @InjectRepository(UserSecret) private readonly secrets: Repository<UserSecret>,
    private readonly crypto: ApiKeyCryptoService,
  ) {}

  async getSecret(userId: string, name: string): Promise<string | null> {
    const row = await this.secrets.findOne({ where: { userId, name }, select: ['encryptedValue'] });
    if (!row) return null;
    return this.crypto.decrypt(row.encryptedValue);
  }

  async hasSecret(userId: string, name: string): Promise<boolean> {
    return (await this.getSecret(userId, name)) !== null;
  }

  async listSecrets(userId: string): Promise<SecretSummary[]> {
    const rows = await this.secrets.find({
      where: { userId },
      select: ['name', 'keyPrefix', 'last4', 'encryptedValue', 'billingTier', 'createdAt', 'updatedAt'],
      order: { createdAt: 'ASC' },
    });
    return rows.map((row) => ({
      name: row.name,
      keyPrefix: row.keyPrefix,
      last4: row.last4,
      status: this.crypto.decrypt(row.encryptedValue) !== null ? 'ok' : 'invalid',
      billingTier: row.billingTier ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async setSecret(userId: string, name: string, value: string): Promise<SecretSummary> {
    if (!SECRET_NAME_RE.test(name)) {
      throw new BadRequestException(
        'secret name must start with a letter/digit and contain only letters, digits, "_" or "-"',
      );
    }
    if (!this.crypto.enabled) {
      throw new BadRequestException(
        'server cannot store secrets securely (API_KEY_ENCRYPTION_SECRET is not set)',
      );
    }
    const normalized = value.trim();
    if (!normalized) throw new BadRequestException('secret value is required');
    if (normalized.length < 4) {
      throw new BadRequestException('that does not look like a valid secret (too short)');
    }
    if (name === SECRET_HUGGING_FACE && !normalized.startsWith('hf_')) {
      throw new BadRequestException(
        'invalid Hugging Face token — it should start with "hf_". Get one at huggingface.co/settings/tokens',
      );
    }

    const encrypted = this.crypto.encrypt(normalized);
    const existing = await this.secrets.findOne({ where: { userId, name } });
    const row = existing ?? this.secrets.create({ userId, name });
    row.encryptedValue = encrypted;
    row.keyPrefix = `${normalized.slice(0, 9)}…`;
    row.last4 = normalized.slice(-4);

    // For the Hugging Face token, detect the account billing tier from whoami
    // and persist it so the agent can pick free-tier vs paid models accordingly.
    if (name === SECRET_HUGGING_FACE) {
      const detected = await this.detectHuggingFaceTier(normalized);
      if (detected) {
        row.billingTier = detected.tier;
        row.billingMeta = JSON.stringify(detected.meta);
      }
    }

    await this.secrets.save(row);

    return {
      name,
      keyPrefix: row.keyPrefix,
      last4: row.last4,
      status: 'ok',
      billingTier: row.billingTier ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async removeSecret(userId: string, name: string): Promise<void> {
    await this.secrets.delete({ userId, name });
  }

  /** Raw resolution: stored secret wins, falls back to the env variable. */
  async getHuggingFaceToken(userId: string): Promise<string | null> {
    const stored = await this.getSecret(userId, SECRET_HUGGING_FACE);
    if (stored) return stored;
    const env = process.env[HUGGING_FACE_ENV]?.trim();
    return env || null;
  }

  /**
   * Status used by the Hugging Face settings UI and the dynamic system prompt.
   * When a token is configured it is live-validated against the HF whoami
   * endpoint so the UI can show ok/invalid honestly.
   */
  async getHuggingFaceStatus(userId: string): Promise<HuggingFaceStatusInfo> {
    const token = await this.getHuggingFaceToken(userId);
    if (!token) {
      return { configured: false, status: 'invalid', envName: HUGGING_FACE_ENV, tier: null, billingMeta: null };
    }
    const row = await this.secrets.findOne({ where: { userId, name: SECRET_HUGGING_FACE } });
    let tier: 'free' | 'paid' | null = row?.billingTier ?? null;
    let billingMeta: Record<string, unknown> | null = null;
    if (row?.billingMeta) {
      try { billingMeta = JSON.parse(row.billingMeta); } catch { billingMeta = null; }
    }
    const validated = await this.cachedValidation(userId, token);
    // Re-detect the tier lazily when unknown so the agent always gets an answer.
    if (validated === 'ok' && tier === null) {
      const detected = await this.detectHuggingFaceTier(token);
      if (detected) {
        tier = detected.tier;
        billingMeta = detected.meta;
        if (row) {
          row.billingTier = tier;
          row.billingMeta = JSON.stringify(detected.meta);
          await this.secrets.save(row);
        }
      }
    }
    return {
      configured: true,
      status: validated,
      envName: HUGGING_FACE_ENV,
      tier,
      billingMeta,
    };
  }

  /** Validation results are cached briefly so the agent system-prompt build
   *  stays offline after the first check (whoami is only live-checked on the
   *  Settings UI / first run). */
  private readonly validationCache = new Map<string, { status: 'ok' | 'invalid'; at: number }>();
  private static readonly VALIDATION_TTL_MS = 60_000;

  private async cachedValidation(userId: string, token: string): Promise<'ok' | 'invalid'> {
    const cached = this.validationCache.get(userId);
    if (cached && Date.now() - cached.at < SecretsService.VALIDATION_TTL_MS) {
      return cached.status;
    }
    const status = await this.validateHuggingFaceToken(token);
    this.validationCache.set(userId, { status, at: Date.now() });
    return status;
  }

  async validateHuggingFaceToken(token: string): Promise<'ok' | 'invalid'> {
    if (!token.startsWith('hf_')) return 'invalid';
    try {
      const res = await fetch(HUGGING_FACE_WHOAMI_URL, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
      return res.ok ? 'ok' : 'invalid';
    } catch (err) {
      this.logger.warn(`hugging face token validation failed (treating as ok): ${err}`);
      return 'ok';
    }
  }

  /**
   * Detect whether a Hugging Face token belongs to a free (Basic) or paid
   * (Pro / billing-enabled) account by inspecting whoami-v2. Only returns a
   * result when the whoami call succeeds; otherwise null (unknown).
   */
  async detectHuggingFaceTier(token: string): Promise<{ tier: 'free' | 'paid'; meta: HuggingFaceWhoami } | null> {
    if (!token.startsWith('hf_')) return null;
    try {
      const res = await fetch(HUGGING_FACE_WHOAMI_URL, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      const whoami = (await res.json()) as HuggingFaceWhoami;
      const meta: HuggingFaceWhoami = {
        name: whoami.name,
        canPay: Boolean(whoami.canPay),
        isPro: Boolean(whoami.isPro),
        billingMode: whoami.billingMode,
        periodEnd: whoami.periodEnd,
      };
      const paid = whoami.isPro === true || whoami.canPay === true;
      return { tier: paid ? 'paid' : 'free', meta };
    } catch (err) {
      this.logger.warn(`hugging face tier detection failed: ${err}`);
      return null;
    }
  }

  /** Provider detail lookup for the agent/system prompt (never the raw value). */
  async findSecretOrThrow(userId: string, name: string): Promise<UserSecret> {
    const row = await this.secrets.findOne({ where: { userId, name } });
    if (!row) throw new NotFoundException(`no secret named "${name}" saved`);
    return row;
  }
}