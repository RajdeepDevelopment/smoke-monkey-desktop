import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SshConnection } from './entities/ssh-connection.entity';
import { SshService } from './ssh.service';
import { SshController } from './ssh.controller';
import { ConnectorRegistry } from './connector.registry';
import { ApiKeysModule } from '../keys/api-keys.module';
import { ApiKeyCryptoService } from '../keys/api-key-crypto.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([SshConnection]), ApiKeysModule],
  controllers: [SshController],
  providers: [
    {
      provide: 'SshCrypto',
      useExisting: ApiKeyCryptoService,
    },
    {
      provide: ConnectorRegistry,
      useFactory: (ssh: SshService) => {
        const registry = new ConnectorRegistry();
        registry.register(ssh);
        return registry;
      },
      inject: [SshService],
    },
    SshService,
  ],
  exports: [SshService, ConnectorRegistry, TypeOrmModule],
})
export class SshModule {}
