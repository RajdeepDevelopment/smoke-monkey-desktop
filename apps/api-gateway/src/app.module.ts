import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildTypeOrmOptions } from './config/typeorm.config';
import { CommonModule } from './common/services/common.module';
import { AuthModule } from './modules/auth/auth.module';
import { ChatModule } from './modules/chat/chat.module';
import { Conversation } from './modules/conversations/conversation.entity';
import { ConversationsModule } from './modules/conversations/conversations.module';
import { Message } from './modules/conversations/message.entity';
import { DocumentEntity } from './modules/documents/document.entity';
import { DocumentsModule } from './modules/documents/documents.module';
import { HealthModule } from './modules/health/health.module';
import { ApiKeysModule } from './modules/keys/api-keys.module';
import { UserApiKey } from './modules/keys/user-api-key.entity';
import { ModelsModule } from './modules/models/models.module';
import { PlaygroundModule } from './modules/playground/playground.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { SettingsModule } from './modules/settings/settings.module';
import { User } from './modules/users/user.entity';
import { UsersModule } from './modules/users/users.module';
import { AgentModule } from './modules/agent/agent.module';
import { AgentSession } from './modules/agent/entities/agent-session.entity';
import { AgentRun } from './modules/agent/entities/agent-run.entity';
import { AgentMessage } from './modules/agent/entities/agent-message.entity';
import { AgentFileChange } from './modules/agent/entities/agent-file-change.entity';
import { AgentPermission } from './modules/agent/entities/agent-permission.entity';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        buildTypeOrmOptions(config, {
          entities: [User, DocumentEntity, Conversation, Message, UserApiKey, AgentSession, AgentRun, AgentMessage, AgentFileChange, AgentPermission],
        }),
    }),
    CommonModule,
    UsersModule,
    AuthModule,
    DocumentsModule,
    ConversationsModule,
    ChatModule,
    HealthModule,
    ModelsModule,
    ApiKeysModule,
    PlaygroundModule,
    AnalyticsModule,
    SettingsModule,
    AgentModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
