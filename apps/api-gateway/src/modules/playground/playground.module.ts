import { Module } from '@nestjs/common';
import { ApiKeysModule } from '../keys/api-keys.module';
import { PlaygroundController } from './playground.controller';
import { PlaygroundService } from './playground.service';

@Module({
  imports: [ApiKeysModule],
  controllers: [PlaygroundController],
  providers: [PlaygroundService],
})
export class PlaygroundModule {}
