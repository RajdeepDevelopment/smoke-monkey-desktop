import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { connect, JetStreamClient, NatsConnection, StorageType } from 'nats';

@Injectable()
export class NatsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NatsService.name);
  private nc: NatsConnection | null = null;
  private js: JetStreamClient | null = null;
  private connected = false;

  async onModuleInit() {
    if (process.env.DB_DRIVER === 'sqlite') {
      this.logger.warn('SQLite mode — NATS skipped');
      return;
    }
    try {
      const servers = process.env.NATS_URL || 'nats://localhost:4222';
      this.nc = await connect({ servers });
      this.js = this.nc.jetstream();
      await this.ensureStream();
      this.connected = true;
      this.logger.log(`connected to NATS at ${servers}`);
    } catch {
      this.nc = null;
      this.js = null;
      this.connected = false;
      this.logger.warn('NATS unavailable — document streaming disabled');
    }
  }

  private async ensureStream(): Promise<void> {
    if (!this.nc) return;
    const name = process.env.NATS_STREAM || 'DOCUMENTS';
    const jsm = await this.nc.jetstreamManager();
    try {
      await jsm.streams.info(name);
    } catch {
      await jsm.streams.add({
        name,
        subjects: ['documents.>'],
        storage: StorageType.File,
        max_age: 7 * 24 * 3600 * 1_000_000_000,
      });
      this.logger.log(`created JetStream stream ${name}`);
    }
  }

  async publish(subject: string, payload: unknown): Promise<void> {
    if (!this.connected || !this.js) {
      this.logger.warn(`NATS unavailable — skipping publish to ${subject}`);
      return;
    }
    try {
      await this.js.publish(subject, JSON.stringify(payload));
    } catch (err) {
      this.logger.warn(`NATS publish failed: ${err}`);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  onModuleDestroy(): void {
    this.connected = false;
    this.nc?.close().catch((): void => undefined);
  }
}
