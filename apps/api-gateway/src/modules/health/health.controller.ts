import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NatsService } from '../../common/services/nats.service';
import { RedisService } from '../../common/services/redis.service';

@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: RedisService,
    private readonly nats: NatsService,
  ) {}

  @Get()
  async check() {
    const checks: Record<string, boolean> = { database: false, redis: false, nats: false };
    try {
      await this.dataSource.query('SELECT 1');
      checks.database = true;
    } catch {
      /* not healthy */
    }
    try {
      await this.redis.ping();
      checks.redis = true;
    } catch {
      /* not healthy */
    }
    checks.nats = this.nats.isConnected();
    return { status: Object.values(checks).every(Boolean) ? 'ok' : 'degraded', ...checks };
  }
}
