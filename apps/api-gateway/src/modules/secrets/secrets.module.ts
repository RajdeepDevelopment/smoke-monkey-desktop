import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommonModule } from '../../common/services/common.module';
import { ApiKeysModule } from '../keys/api-keys.module';
import { SecretsController } from './secrets.controller';
import { SecretsService } from './secrets.service';
import { UserSecret } from './user-secret.entity';

@Module({
  imports: [TypeOrmModule.forFeature([UserSecret]), CommonModule, ApiKeysModule],
  controllers: [SecretsController],
  providers: [SecretsService],
  exports: [SecretsService],
})
export class SecretsModule {}