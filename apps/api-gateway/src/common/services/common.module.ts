import { Module } from '@nestjs/common';
import { MinioService } from './minio.service';
import { NatsService } from './nats.service';
import { RedisService } from './redis.service';

@Module({
  providers: [NatsService, MinioService, RedisService],
  exports: [NatsService, MinioService, RedisService],
})
export class CommonModule {}
