import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module';
import { ApiKeysModule } from '../keys/api-keys.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

@Module({
  imports: [ConversationsModule, ApiKeysModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
