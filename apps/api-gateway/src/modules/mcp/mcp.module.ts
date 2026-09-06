import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { McpServer } from './mcp-server.entity';
import { McpService } from './mcp.service';
import { McpController, McpOAuthPublicController } from './mcp.controller';

@Module({
  imports: [TypeOrmModule.forFeature([McpServer])],
  controllers: [McpController, McpOAuthPublicController],
  providers: [McpService],
  exports: [McpService],
})
export class McpModule {}
