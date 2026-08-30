import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Query,
  Param,
  Req,
  UseGuards,
  BadRequestException,
  HttpException,
  HttpStatus,
  Sse,
  MessageEvent,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { SshService } from './ssh.service';
import { ConnectorRegistry } from './connector.registry';
import { CreateSshConnectionInput } from './ssh.service';

function userIdOf(req: any): string {
  return req?.user?.sub || req?.user?.id || 'public';
}

@UseGuards(JwtAuthGuard)
@Controller('ssh')
export class SshController {
  constructor(
    private readonly ssh: SshService,
    private readonly connectors: ConnectorRegistry,
  ) {}

  // ── Connector registry (extension surface) ──────────────────────────────

  @Get('connectors')
  listConnectors() {
    return this.connectors.listDescriptors();
  }

  @Get('destinations')
  async listDestinations(@Req() req: any) {
    const userId = userIdOf(req);
    const out: Record<string, unknown>[] = [];
    for (const c of this.connectors.getAll()) {
      try {
        const dests = await c.listDestinations(userId);
        out.push({ connector: c.id, label: c.label, destinations: dests });
      } catch (err: any) {
        out.push({ connector: c.id, label: c.label, destinations: [], error: err.message });
      }
    }
    return out;
  }

  // ── Profiles ────────────────────────────────────────────────────────────

  @Get('profiles')
  async listProfiles(@Req() req: any) {
    const userId = userIdOf(req);
    const rows = await this.ssh.findAll(userId);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      host: r.host,
      port: r.port,
      username: r.username,
      authMethod: r.authMethod,
      remoteHome: r.remoteHome,
      strictHostKey: r.strictHostKey,
      keyFingerprint: r.keyFingerprint,
      lastError: r.lastError,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  @Post('profiles')
  async createProfile(@Req() req: any, @Body() body: CreateSshConnectionInput) {
    if (!body.name || !body.host) throw new BadRequestException('name and host are required');
    try {
      const row = await this.ssh.create(userIdOf(req), body);
      return { id: row.id, name: row.name, host: row.host, port: row.port, username: row.username, authMethod: row.authMethod };
    } catch (err: any) {
      throw new HttpException(err.message || 'Failed to save SSH connection', HttpStatus.BAD_REQUEST);
    }
  }

  @Delete('profiles/:id')
  async deleteProfile(@Req() req: any, @Param('id') id: string) {
    if (!id) throw new BadRequestException('id required');
    await this.ssh.remove(userIdOf(req), id);
    return { status: 'deleted' };
  }

  @Post('profiles/:id/test')
  async testProfile(@Req() req: any, @Param('id') id: string) {
    if (!id) throw new BadRequestException('id required');
    return this.ssh.test(id, userIdOf(req));
  }

  // ── Exec / terminal ─────────────────────────────────────────────────────

  @Post('exec')
  async exec(@Req() req: any, @Body() body: { id: string; command: string; cwd?: string }) {
    const userId = userIdOf(req);
    if (!body.id || !body.command) throw new BadRequestException('id and command required');
    const out = await this.ssh.exec(body.id, userId, body.command, { cwd: body.cwd });
    if (out.exitCode === 255) {
      throw new HttpException(out.stderr || 'SSH connection failed', HttpStatus.BAD_GATEWAY);
    }
    return { stdout: out.stdout, stderr: out.stderr, exitCode: out.exitCode, timedOut: !!out.timedOut };
  }

  // ── Streaming exec (SSE) ────────────────────────────────────────────────

  @Sse('exec/stream')
  streamExec(@Query('id') id: string | undefined, @Query('command') command: string | undefined, @Req() req: any): Observable<MessageEvent> {
    if (!id || !command) {
      return new Observable<MessageEvent>((sub) => sub.error({ type: 'error', data: 'id and command required' }));
    }
    const userId = userIdOf(req);
    return new Observable<MessageEvent>((subscriber) => {
      let timer: ReturnType<typeof setInterval>;
      timer = setInterval(() => {
        // SSE keepalive so the connection isn't torn down during silence.
        subscriber.next({ type: 'ping', data: 'ping' } as MessageEvent);
      }, 15_000);
      timer.unref?.();

      this.ssh
        .streamExec(id, userId, command, (chunk) => {
          subscriber.next({ type: 'output', data: JSON.stringify(chunk) } as MessageEvent);
        })
        .then((result) => {
          clearInterval(timer);
          subscriber.next({ type: 'done', data: JSON.stringify({ exitCode: result.exitCode, timedOut: !!result.timedOut }) } as MessageEvent);
          subscriber.complete();
        })
        .catch((err: Error) => {
          clearInterval(timer);
          subscriber.error({ type: 'error', data: err.message || String(err) } as MessageEvent);
        });
    });
  }

  // ── Remote file ops ─────────────────────────────────────────────────────

  @Get('ls')
  async listRemote(@Req() req: any, @Query('id') id?: string, @Query('path') remotePath?: string) {
    if (!id) throw new BadRequestException('id required');
    return this.ssh.list(id, userIdOf(req), remotePath || '~');
  }

  @Get('file-tree')
  async fileTreeRemote(@Req() req: any, @Query('id') id?: string, @Query('path') remotePath?: string, @Query('depth') depth?: string) {
    if (!id) throw new BadRequestException('id required');
    return this.ssh.listTree(id, userIdOf(req), remotePath || '~', depth ? parseInt(depth, 10) : 2);
  }

  @Get('git-status')
  async gitStatusRemote(@Req() req: any, @Query('id') id?: string, @Query('path') remotePath?: string) {
    if (!id) throw new BadRequestException('id required');
    return this.ssh.gitStatusRemote(id, userIdOf(req), remotePath || '~');
  }

  @Get('read')
  async readRemote(@Req() req: any, @Query('id') id?: string, @Query('path') remotePath?: string) {
    if (!id || !remotePath) throw new BadRequestException('id and path required');
    return this.ssh.read(id, userIdOf(req), remotePath);
  }

  @Post('write')
  async writeRemote(@Req() req: any, @Body() body: { id: string; path: string; content: string }) {
    if (!body.id || !body.path) throw new BadRequestException('id and path required');
    await this.ssh.write(body.id, userIdOf(req), body.path, body.content ?? '');
    return { status: 'written' };
  }

  @Post('create')
  async createRemote(@Req() req: any, @Body() body: { id: string; path: string; type: 'file' | 'directory' }) {
    if (!body.id || !body.path) throw new BadRequestException('id and path required');
    await this.ssh.createEntry(body.id, userIdOf(req), body.path, body.type || 'file');
    return { status: 'created' };
  }

  @Post('rename')
  async renameRemote(@Req() req: any, @Body() body: { id: string; from: string; to: string }) {
    if (!body.id || !body.from || !body.to) throw new BadRequestException('id, from and to required');
    await this.ssh.renameEntry(body.id, userIdOf(req), body.from, body.to);
    return { status: 'renamed' };
  }

  @Delete('path')
  async deleteRemote(@Req() req: any, @Query('id') id?: string, @Query('path') remotePath?: string) {
    if (!id || !remotePath) throw new BadRequestException('id and path required');
    await this.ssh.deleteEntry(id, userIdOf(req), remotePath);
    return { status: 'deleted' };
  }
}
