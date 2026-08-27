import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommonModule } from '../../common/services/common.module';
import { ApiKeyCryptoService } from './api-key-crypto.service';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';
import { UserApiKey } from './user-api-key.entity';

@Module({
  imports: [TypeOrmModule.forFeature([UserApiKey]), CommonModule],
  controllers: [ApiKeysController],
  providers: [ApiKeysService, ApiKeyCryptoService],
  exports: [ApiKeysService, ApiKeyCryptoService],
})
export class ApiKeysModule {}
