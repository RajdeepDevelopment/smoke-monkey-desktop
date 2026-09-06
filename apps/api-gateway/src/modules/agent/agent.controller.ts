import { Controller, Post, Get, Delete, Body, Param, Req, Sse, MessageEvent, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { Observable, filter, map } from 'rxjs';
import { AgentService, AgentRunRequest } from './services/agent.service';
import { AgentSessionService } from './services/agent-session.service';
import { AgentRunService } from './services/agent-run.service';
import { AgentMessageService } from './services/agent-message.service';
import { AgentPermissionService } from './services/agent-permission.service';
import { AgentEventEmitter, AgentEvent } from './services/agent-event.emitter';
import { ContextCompactionService } from './services/compaction.service';
import { ExplorerService } from './services/subagent.service';
import { AgentId } from './entities/agent-session.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentFileChange } from './entities/agent-file-change.entity';
import { ToolRegistry } from './tools/tool-registry';
import { Inject } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import * as fs from 'fs';
import { OPENCODE_ZEN_MODEL_IDS } from '../../common/constants/opencode-models';
import * as path from 'path';

const execAsync = promisify(exec);

@UseGuards(JwtAuthGuard)
@Controller('agent')
export class AgentController {
  constructor(
    private readonly agentService: AgentService,
    private readonly sessionService: AgentSessionService,
    private readonly runService: AgentRunService,
    private readonly messageService: AgentMessageService,
    private readonly permissionService: AgentPermissionService,
    private readonly eventEmitter: AgentEventEmitter,
    private readonly compactionService: ContextCompactionService,
    private readonly explorerService: ExplorerService,
    @InjectRepository(AgentFileChange)
    private readonly fileChangeRepo: Repository<AgentFileChange>,
    @Inject(ToolRegistry)
    private readonly toolRegistry: ToolRegistry,
  ) {}

  @Post('sessions')
  async createSession(
    @Body() body: { agentId?: AgentId; workspacePath?: string; title?: string },
    @Req() req: any,
  ) {
    const userId = req.user?.id || req.userId;
    return this.sessionService.create(userId, body.agentId, body.workspacePath, body.title);
  }

  @Get('sessions')
  async listSessions(@Req() req: any) {
    const userId = req.user?.id || req.userId;
    return this.sessionService.findByUser(userId);
  }

  @Get('sessions/:id')
  async getSession(@Param('id') id: string) {
    return this.sessionService.findOne(id);
  }

  @Delete('sessions/:id')
  async deleteSession(@Param('id') id: string) {
    await this.messageService.deleteBySession(id);
    await this.sessionService.delete(id);
    return { status: 'deleted' };
  }

  @Post('sessions/:id/run')
  async runAgent(
    @Param('id') sessionId: string,
    @Body() body: { message: string; agentId?: AgentId; model?: string; provider?: string; workspacePath?: string; remoteProfileId?: string },
    @Req() req: any,
  ) {
    const userId = req.user?.id || req.userId;
    const session = await this.sessionService.findOne(sessionId);
    if (!session) {
      return { error: 'Session not found' };
    }

    const request: AgentRunRequest = {
      sessionId,
      userId,
      message: body.message,
      workspacePath: body.workspacePath || session.workspacePath || process.cwd(),
      agentId: body.agentId || session.agentId,
      model: body.model,
      provider: body.provider,
      remoteProfileId: body.remoteProfileId,
    };

    this.agentService.run(request).catch((err) => {
      this.eventEmitter.emitRunFailed(sessionId, 'unknown', err.message);
    });

    return { status: 'started', sessionId };
  }

  @Post('sessions/:id/interrupt')
  async interruptRun(@Param('id') sessionId: string) {
    await this.agentService.interrupt(sessionId);
    return { status: 'interrupted' };
  }

  @Post('sessions/:id/continue')
  async continueRun(@Param('id') sessionId: string, @Req() req: any) {
    const userId = req.user?.id || req.userId;
    const session = await this.sessionService.findOne(sessionId);
    if (!session) return { error: 'Session not found' };
    await this.agentService.resume(sessionId, session.workspacePath || process.cwd(), userId);
    return { status: 'resumed' };
  }

  @Get('sessions/:id/messages')
  async getMessages(@Param('id') sessionId: string) {
    return this.messageService.findBySession(sessionId);
  }

  @Get('sessions/:id/runs')
  async getRuns(@Param('id') sessionId: string) {
    return this.runService.findBySession(sessionId);
  }

  @Get('runs/:id/checkpoint')
  async getCheckpoint(@Param('id') runId: string) {
    return this.runService.getCheckpoint(runId);
  }

  @Get('sessions/:id/file-changes')
  async getFileChanges(@Param('id') sessionId: string) {
    const runs = await this.runService.findBySession(sessionId);
    const runIds = runs.map((r) => r.id);
    if (runIds.length === 0) return [];
    return this.fileChangeRepo.find({
      where: runIds.map((id) => ({ runId: id })),
      order: { createdAt: 'DESC' },
      take: 100,
    });
  }

  @Sse('sessions/:id/events')
  streamEvents(@Param('id') sessionId: string): Observable<MessageEvent> {
    const eventTypes = [
      'text.delta', 'text.end',
      'tool.started', 'tool.output', 'tool.completed', 'tool.failed',
      'permission.required',
      'run.started', 'run.completed', 'run.interrupted', 'run.failed',
      'step.started', 'step.ended',
      'llm.thinking',
      'ask_user.required', 'ask_user.response',
      'todo.updated',
    ];

    return new Observable<MessageEvent>((subscriber) => {
      const handlers: Array<{ event: string; handler: (...args: any[]) => void }> = [];

      // Keepalive ping every 15 seconds to prevent proxy/browser timeout
      const keepalive = setInterval(() => {
        try {
          subscriber.next({ type: 'ping', data: '{}' });
        } catch { /* subscriber may be closed */ }
      }, 15_000);

      for (const eventType of eventTypes) {
        const eventName = `agent.session.${sessionId}.${eventType}`;
        const handler = (event: AgentEvent) => {
          try {
            subscriber.next({
              type: event.type,
              data: JSON.stringify(event),
            });
          } catch { /* subscriber may be closed */ }
        };
        this.eventEmitter['eventEmitter'].on(eventName, handler);
        handlers.push({ event: eventName, handler });
      }

      return () => {
        clearInterval(keepalive);
        for (const h of handlers) {
          this.eventEmitter['eventEmitter'].off(h.event, h.handler);
        }
      };
    });
  }

  @Post('permissions')
  async savePermission(
    @Body() body: { tool: string; resource: string; effect: 'allow' | 'deny' | 'ask'; scope: string; workspacePath?: string },
    @Req() req: any,
  ) {
    const userId = req.user?.id || req.userId;
    const workspacePath = body.workspacePath || process.cwd();
    await this.permissionService.saveRule(
      userId, body.tool, body.resource, body.effect, body.scope as any, workspacePath,
    );
    return { status: 'saved' };
  }

  @Get('permissions')
  async getPermissions(@Req() req: any, @Query('workspace') workspace: string) {
    const userId = req.user?.id || req.userId;
    return this.permissionService.getRules(userId, workspace || process.cwd());
  }

  @Post('permissions/:toolCallId/resolve')
  async resolvePermission(
    @Param('toolCallId') toolCallId: string,
    @Body() body: { effect: 'allow' | 'deny' },
  ) {
    await this.permissionService.resolvePendingRequest(toolCallId, body.effect);
    return { status: 'resolved' };
  }

  @Post('ask-user/:toolCallId/resolve')
  async resolveAskUser(
    @Param('toolCallId') toolCallId: string,
    @Body() body: { response: string },
  ) {
    this.agentService.resolveAskUser(toolCallId, body.response);
    return { status: 'resolved' };
  }

  @Get('tools')
  async getTools() {
    return this.toolRegistry.getDefinitions();
  }

  @Get('models')
  async getModels() {
    const ragUrl = process.env.RAG_SERVICE_URL || 'http://127.0.0.1:8643';
    try {
      const upstream = await fetch(`${ragUrl}/api/models`);
      if (!upstream.ok) throw new Error('upstream not ok');
      const data = await upstream.json();
      if (data.providers?.length) return data;
    } catch { /* fall through to desktop defaults */ }

    return {
      providers: [
        {
          id: 'openrouter',
          label: 'OpenRouter',
          models: [
            'anthropic/claude-sonnet-4.6',
            'anthropic/claude-opus-4.6',
            'openai/gpt-5.6-luna-pro',
            'openai/gpt-5.6-luna',
            'google/gemini-3.7-flash',
            'google/gemini-3.6-flash',
            'google/gemini-3.5-flash',
            'google/gemini-3.5-flash-lite',
            'x-ai/grok-4.6',
            'qwen/qwen3-coder',
            'deepseek/deepseek-v4-pro',
          ],
        },
        {
          id: 'nvidia',
          label: 'NVIDIA NIM',
          models: [
            'nvidia/nemotron-3-ultra-550b-a55b',
            'nvidia/nemotron-3-super-120b-a12b',
            'nvidia/nemotron-3-nano-30b-a3b',
          ],
        },
        {
          id: 'openai',
          label: 'OpenAI',
          models: [
            'gpt-5.6',
            'gpt-5.6-luna',
            'o3-pro',
            'gpt-4o',
          ],
        },
        {
          id: 'xai',
          label: 'xAI — Grok',
          models: [
            'grok-4.6',
          ],
        },
        {
          id: 'gemini',
          label: 'Google Gemini',
          models: [
            'gemini-3.7-flash',
            'gemini-3.6-flash',
            'gemini-3.5-flash',
            'gemini-3.5-flash-lite',
          ],
        },
        {
          id: 'opencode',
          label: 'OpenCode Zen',
          models: OPENCODE_ZEN_MODEL_IDS,
        },
        {
          id: 'ollama',
          label: 'Ollama (local)',
          models: [
            'qwen3:32b',
            'qwen3:8b',
            'qwen3:4b',
          ],
        },
      ],
    };
  }

  @Get('file/read')
  fileRead(@Query('path') filePath: string) {
    if (!filePath) throw new BadRequestException('path is required');
    const resolved = path.resolve(filePath);
    try {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) throw new BadRequestException('Path is a directory');
      if (stat.size > 5 * 1024 * 1024) throw new BadRequestException('File too large (>5MB)');
      const content = fs.readFileSync(resolved, 'utf8');
      return { path: resolved, content };
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(`Cannot read file: ${err?.message || err}`);
    }
  }

  @Post('file/write')
  fileWrite(@Body() body: { path?: string; content?: string }) {
    if (!body.path) throw new BadRequestException('path is required');
    const resolved = path.resolve(body.path);
    try {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, body.content ?? '');
      return { ok: true, path: resolved, bytes: Buffer.byteLength(body.content ?? '') };
    } catch (err: any) {
      throw new BadRequestException(`Cannot write file: ${err?.message || err}`);
    }
  }

  @Get('git/diff')
  async gitDiff(@Query('path') repoPath: string, @Query('file') file?: string) {
    const cwd = repoPath || process.cwd();
    const env = { ...process.env, FORCE_COLOR: '0' };
    const target = file ? ` -- ${JSON.stringify(file)}` : '';
    try {
      const { stdout } = await execAsync(`git diff HEAD${target}`, { cwd, env, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
      return { diff: stdout };
    } catch (err: any) {
      throw new BadRequestException(`git diff failed: ${String(err?.message || err).trim()}`);
    }
  }

  @Post('search')
  async searchWorkspace(@Body() body: { query?: string; path?: string; maxResults?: number }) {
    const q = (body.query || '').trim();
    const root = body.path || process.cwd();
    if (!q) return { results: [], truncated: false, tool: 'none' };
    const max = Math.max(1, Math.min(1000, body.maxResults || 300));
    const env = { ...process.env, FORCE_COLOR: '0', PATH: this.getEnhancedPath() };

    // Prefer ripgrep (fast, respects .gitignore); fall back to grep -rn.
    let haveRg = true;
    try {
      await execAsync('command -v rg', { env, timeout: 3000 });
    } catch {
      haveRg = false;
    }

    if (haveRg) {
      try {
        const rgCmd = `(rg --no-heading --color never -S -n --glob '!**/node_modules/**' --glob '!**/.git/**' --glob '!**/.next/**' --glob '!**/dist/**' -e ${this.shellEscape(q)} ${JSON.stringify(root)} || true) | head -n ${max}`;
        const { stdout } = await execAsync(rgCmd, { cwd: root, timeout: 20_000, maxBuffer: 8 * 1024 * 1024, env });
        return this.parseSearchOutput(stdout, max, 'ripgrep');
      } catch { /* fall through to grep */ }
    }

    try {
      const grepCmd = `(grep -rnIF --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next --exclude-dir=dist --exclude-dir=target --exclude-dir=build -i -e ${this.shellEscape(q)} ${JSON.stringify(root)} || true) | head -n ${max}`;
      const { stdout } = await execAsync(grepCmd, { cwd: root, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, env });
      return this.parseSearchOutput(stdout, max, 'grep');
    } catch (err: any) {
      throw new BadRequestException(`search failed: ${String(err?.message || err).trim()}`);
    }
  }

  private shellEscape(s: string): string {
    return "'" + s.replace(/'/g, `'\\''`) + "'";
  }

  private parseSearchOutput(stdout: string, max: number, tool: string) {
    const results: Array<{ file: string; line: number; text: string }> = [];
    for (const line of stdout.split('\n')) {
      if (!line) continue;
      const i1 = line.indexOf(':');
      const i2 = line.indexOf(':', i1 + 1);
      if (i1 <= 0 || i2 < 0) continue;
      const file = line.slice(0, i1);
      const lineNo = parseInt(line.slice(i1 + 1, i2), 10);
      if (Number.isNaN(lineNo)) continue;
      results.push({ file, line: lineNo, text: line.slice(i2 + 1).slice(0, 400) });
      if (results.length >= max) break;
    }
    return { results, truncated: results.length >= max, tool };
  }

  @Post('terminal/exec')
  async execTerminal(@Body() body: { command: string; cwd?: string }) {
    try {
      const { stdout, stderr } = await execAsync(body.command, {
        cwd: body.cwd || process.cwd(),
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, FORCE_COLOR: '0', PATH: this.getEnhancedPath() },
      });
      return { stdout: stdout || '', stderr: stderr || '', exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || err.message || 'Command failed',
        exitCode: err.status || 1,
      };
    }
  }

  @Post('docker/exec')
  async execDocker(@Body() body: { container: string; command: string; cwd?: string }) {
    try {
      const dockerCmd = `docker exec -w "${body.cwd || '/'}" ${body.container} sh -c ${JSON.stringify(body.command)}`;
      const { stdout, stderr } = await execAsync(dockerCmd, {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, FORCE_COLOR: '0' },
      });
      return { stdout: stdout || '', stderr: stderr || '', exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || err.message || 'Docker command failed',
        exitCode: err.status || 1,
      };
    }
  }

  @Get('docker/containers')
  async listDockerContainers() {
    try {
      const { stdout } = await execAsync('docker ps -a --format "{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}"', {
        timeout: 10_000,
      });
      const containers = (stdout || '').trim().split('\n').filter(Boolean).map((line) => {
        const [id, name, image, status] = line.split('|');
        return { id, name, image, status };
      });
      return { containers };
    } catch {
      return { containers: [] as Array<{ id: string; name: string; image: string; status: string }>, error: 'Docker not available' };
    }
  }

  private getEnhancedPath(): string {
    const extraPaths: string[] = [];
    const home = process.env.HOME || '';
    const nvmDir = process.env.NVM_DIR || `${home}/.nvm`;
    try {
      const nvmLinks = fs.readdirSync(`${nvmDir}/versions/node`);
      const latest = nvmLinks.sort().pop();
      if (latest) extraPaths.push(`${nvmDir}/versions/node/${latest}/bin`);
    } catch { /* no nvm */ }
    try {
      if (fs.statSync(`${home}/.local/share/fnm`).isDirectory()) extraPaths.push(`${home}/.local/share/fnm`);
    } catch { /* no fnm */ }
    try {
      if (fs.statSync(`${home}/.volta/bin`).isDirectory()) extraPaths.push(`${home}/.volta/bin`);
    } catch { /* no volta */ }
    return [...extraPaths, process.env.PATH || '/usr/local/bin:/usr/bin:/bin'].join(':');
  }

  @Post('sessions/:id/explore')
  async spawnExplore(
    @Param('id') parentSessionId: string,
    @Body() body: { task: string; workspacePath?: string },
    @Req() req: any,
  ) {
    const userId = req.user?.id || req.userId;
    const session = await this.sessionService.findOne(parentSessionId);
    const workspacePath = body.workspacePath || session?.workspacePath || process.cwd();
    const abortController = new AbortController();
    const result = await this.explorerService.spawnExplore(
      parentSessionId, body.task, workspacePath, userId, abortController.signal,
    );
    return result;
  }

  @Post('sessions/:id/compact')
  async compactSession(@Param('id') sessionId: string, @Body() body: { provider?: string; model?: string }) {
    const result = await this.compactionService.compact(sessionId, body.provider, body.model);
    return result || { message: 'No compaction needed' };
  }

  @Get('compaction/check/:id')
  async checkCompaction(@Param('id') sessionId: string) {
    const should = await this.compactionService.shouldCompact(sessionId);
    return { shouldCompact: should };
  }
}
