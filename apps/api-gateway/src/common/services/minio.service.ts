import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Client } from 'minio';

@Injectable()
export class MinioService implements OnModuleInit {
  private readonly logger = new Logger(MinioService.name);
  client: Client | null = null;
  private available = false;
  readonly bucket = process.env.MINIO_BUCKET || 'documents';

  async onModuleInit() {
    if (process.env.DB_DRIVER === 'sqlite') {
      this.logger.warn('SQLite mode — MinIO skipped');
      return;
    }
    try {
      this.client = new Client({
        endPoint: process.env.MINIO_ENDPOINT || 'localhost',
        port: Number(process.env.MINIO_PORT || 9000),
        useSSL: process.env.MINIO_SECURE === 'true',
        accessKey: process.env.MINIO_ACCESS_KEY || 'ragminio',
        secretKey: process.env.MINIO_SECRET_KEY || 'ragminio_secret',
      });
      const exists = await this.client.bucketExists(this.bucket);
      if (!exists) {
        await this.client.makeBucket(this.bucket);
        this.logger.log(`created bucket ${this.bucket}`);
      }
      this.available = true;
    } catch {
      this.client = null;
      this.available = false;
      this.logger.warn('MinIO unavailable — document uploads disabled');
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  async upload(key: string, buffer: Buffer, contentType: string): Promise<void> {
    if (!this.available || !this.client) {
      throw new Error('MinIO unavailable — cannot upload');
    }
    await this.client.putObject(this.bucket, key, buffer, buffer.length, {
      'Content-Type': contentType,
    });
  }

  async remove(key: string): Promise<void> {
    if (!this.available || !this.client) return;
    try {
      await this.client.removeObject(this.bucket, key);
    } catch (err) {
      this.logger.warn(`failed to remove ${key}: ${err}`);
    }
  }
}
