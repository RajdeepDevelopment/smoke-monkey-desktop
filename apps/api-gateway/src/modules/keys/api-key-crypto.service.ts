import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';

/**
 * Encrypts/decrypts user provider keys at rest using AES-256-GCM.
 * The key is derived (SHA-256) from API_KEY_ENCRYPTION_SECRET so we can accept
 * a plain-text 32+ char secret in env without requiring exact base64/hex form.
 */
@Injectable()
export class ApiKeyCryptoService {
  private readonly logger = new Logger(ApiKeyCryptoService.name);
  private readonly secretKey: Buffer;

  constructor() {
    const secret = process.env.API_KEY_ENCRYPTION_SECRET || '';
    if (secret.length < 16) {
      this.logger.warn(
        'API_KEY_ENCRYPTION_SECRET is missing or too short — user keys will not be persisted',
      );
    }
    this.secretKey = createHash('sha256').update(secret).digest();
  }

  get enabled(): boolean {
    return this.secretKey.length === 32 && !!process.env.API_KEY_ENCRYPTION_SECRET;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.secretKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
  }

  decrypt(payload: string): string | null {
    try {
      const [ivB64, tagB64, dataB64] = payload.split(':');
      if (!ivB64 || !tagB64 || !dataB64) return null;
      const decipher = createDecipheriv(ALGORITHM, this.secretKey, Buffer.from(ivB64, 'base64'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch (err) {
      this.logger.warn('failed to decrypt a stored API key (secret rotated?): %s', (err as Error).message);
      return null;
    }
  }
}
