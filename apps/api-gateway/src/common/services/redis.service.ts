import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;
  private available = false;

  async onModuleInit() {
    if (process.env.DB_DRIVER === 'sqlite') {
      this.logger.warn('SQLite mode — Redis skipped');
      return;
    }
    try {
      this.client = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT || 6379),
        password: process.env.REDIS_PASSWORD || undefined,
        lazyConnect: true,
        connectTimeout: 3000,
        retryStrategy: () => null,
        maxRetriesPerRequest: 0,
      });
      await this.client.connect();
      this.available = true;
      this.logger.log('connected to Redis');
    } catch {
      this.client = null;
      this.available = false;
      this.logger.warn('Redis unavailable — caching disabled');
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  async get(key: string): Promise<string | null> {
    if (!this.available) return null;
    try {
      return await this.client!.get(key);
    } catch {
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (!this.available) return;
    try {
      if (ttlSeconds) await this.client!.set(key, value, 'EX', ttlSeconds);
      else await this.client!.set(key, value);
    } catch { /* ignore */ }
  }

  async del(pattern: string): Promise<void> {
    if (!this.available) return;
    try {
      const keys = await this.client!.keys(pattern);
      if (keys.length) await this.client!.del(...keys);
    } catch { /* ignore */ }
  }

  async ping(): Promise<string> {
    if (!this.available) throw new Error('Redis unavailable');
    return this.client!.ping();
  }

  onModuleDestroy() {
    this.client?.disconnect();
  }
}
