import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module';
import { ApiKeysModule } from '../keys/api-keys.module';
import { SecretsModule } from '../secrets/secrets.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

@Module({
  imports: [ConversationsModule, ApiKeysModule, SecretsModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
