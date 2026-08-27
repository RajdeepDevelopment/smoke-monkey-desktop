import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventEmitterModule, EventEmitter2 } from '@nestjs/event-emitter';
import { AgentController } from './agent.controller';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';
import { AgentGateway } from './agent.gateway';
import { AgentService } from './services/agent.service';
import { AgentSessionService } from './services/agent-session.service';
import { AgentRunService } from './services/agent-run.service';
import { AgentMessageService } from './services/agent-message.service';
import { AgentPermissionService } from './services/agent-permission.service';
import { AgentEventEmitter } from './services/agent-event.emitter';
import { ContextCompactionService } from './services/compaction.service';
import { ExplorerService } from './services/subagent.service';
import { WorkspaceIndex } from './services/workspace-index';
import { AgentConfigService } from './services/agent-config.service';
import { AgentSession } from './entities/agent-session.entity';
import { AgentRun } from './entities/agent-run.entity';
import { AgentMessage } from './entities/agent-message.entity';
import { AgentFileChange } from './entities/agent-file-change.entity';
import { AgentPermission } from './entities/agent-permission.entity';
import { ToolRegistry } from './tools/tool-registry';
import { getReadFileTool, getWriteFileTool, getEditFileTool, getApplyPatchTool, getDeleteFileTool, getListDirectoryTool } from './tools/filesystem.tools';
import { getRunCommandTool, getRunTestTool, getDockerExecTool, getDockerListTool } from './tools/terminal.tools';
import { getGlobTool, getGrepTool, getFindSymbolTool, getSearchCodeTool } from './tools/search.tools';
import { getGitStatusTool, getGitDiffTool, getGitLogTool } from './tools/git.tools';
import { getTodoWriteTool, getAskUserTool } from './tools/agent.tools';
import { AuthModule } from '../auth/auth.module';
import { ApiKeysModule } from '../keys/api-keys.module';

const toolRegistryProvider = {
  provide: ToolRegistry,
  useFactory: () => {
    const registry = new ToolRegistry();
    registry.register(getReadFileTool());
    registry.register(getWriteFileTool());
    registry.register(getEditFileTool());
    registry.register(getApplyPatchTool());
    registry.register(getDeleteFileTool());
    registry.register(getListDirectoryTool());
    registry.register(getRunCommandTool());
    registry.register(getRunTestTool());
    registry.register(getDockerExecTool());
    registry.register(getDockerListTool());
    registry.register(getGlobTool());
    registry.register(getGrepTool());
    registry.register(getFindSymbolTool());
    registry.register(getSearchCodeTool());
    registry.register(getGitStatusTool());
    registry.register(getGitDiffTool());
    registry.register(getGitLogTool());
    registry.register(getTodoWriteTool());
    registry.register(getAskUserTool());
    return registry;
  },
};

const eventEmitterProvider = {
  provide: AgentEventEmitter,
  inject: [EventEmitter2],
  useFactory: (eventEmitter: any) => new AgentEventEmitter(eventEmitter),
};

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    AuthModule,
    ApiKeysModule,
    TypeOrmModule.forFeature([
      AgentSession,
      AgentRun,
      AgentMessage,
      AgentFileChange,
      AgentPermission,
    ]),
  ],
  controllers: [AgentController, WorkspaceController],
  providers: [
    toolRegistryProvider,
    eventEmitterProvider,
    AgentGateway,
    WorkspaceService,
    AgentService,
    AgentSessionService,
    AgentRunService,
    AgentMessageService,
    AgentPermissionService,
    ContextCompactionService,
    ExplorerService,
    WorkspaceIndex,
    AgentConfigService,
  ],
  exports: [AgentService, ToolRegistry, AgentEventEmitter, AgentGateway, ContextCompactionService, ExplorerService, WorkspaceIndex, AgentConfigService],
})
export class AgentModule {}
