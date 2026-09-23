import { Controller, Get, Post, Delete, Body, Query, Req, UseGuards, Sse, MessageEvent, BadRequestException } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { WorkspaceService } from './workspace.service';

@UseGuards(JwtAuthGuard)
@Controller('agent')
export class WorkspaceController {
  constructor(private readonly workspace: WorkspaceService) {}

  @Get('file-tree')
  async getFileTree(@Query('path') dirPath: string, @Query('depth') depth?: string) {
    const root = dirPath || process.cwd();
    return this.workspace.listTree(root, depth ? parseInt(depth, 10) : 2);
  }

  @Get('fs/file')
  async readFile(@Query('path') p: string) {
    if (!p) throw new BadRequestException('path required');
    return this.workspace.readFile(p);
  }

  @Get('fs/raw')
  async readRawFile(@Query('path') p: string) {
    if (!p) throw new BadRequestException('path required');
    return this.workspace.readRaw(p);
  }

  @Post('fs/write')
  async writeFile(@Body() body: { path: string; content: string }) {
    await this.workspace.writeFile(body.path, body.content ?? '');
    return { status: 'written' };
  }

  @Post('fs/create')
  async createEntry(@Body() body: { path: string; type: 'file' | 'directory' }) {
    try {
      await this.workspace.createEntry(body.path, body.type);
    } catch (err: any) {
      if (String(err.message).includes('exists')) throw new BadRequestException('Already exists');
      throw err;
    }
    return { status: 'created' };
  }

  @Post('fs/rename')
  async renameEntry(@Body() body: { from: string; to: string }) {
    await this.workspace.renameEntry(body.from, body.to);
    return { status: 'renamed' };
  }

  @Delete('fs/path')
  async deleteEntry(@Query('path') p: string) {
    if (!p) throw new BadRequestException('path required');
    await this.workspace.deleteEntry(p);
    return { status: 'deleted' };
  }

  @Post('fs/reveal')
  async reveal(@Body() body: { path: string }) {
    await this.workspace.revealInFinder(body.path);
    return { status: 'ok' };
  }

  @Post('fs/open')
  async openWithDefaultApp(@Body() body: { path: string }) {
    if (!body.path) throw new BadRequestException('path required');
    await this.workspace.openWithDefaultApp(body.path);
    return { status: 'ok' };
  }

  // ── Git ──────────────────────────────────────────────────────────────────

  @Get('git/status')
  async gitStatus(@Query('path') root: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    const opts: { limit?: number; offset?: number } = {};
    if (limit !== undefined) opts.limit = Math.max(1, parseInt(limit, 10) || 1);
    if (offset !== undefined) opts.offset = Math.max(0, parseInt(offset, 10) || 0);
    return this.workspace.gitStatus(root || process.cwd(), opts);
  }

  @Get('git/diff-file')
  async gitDiffFile(@Query('path') root: string, @Query('file') file: string) {
    if (!file) throw new BadRequestException('file required');
    return this.workspace.gitDiffFile(root || process.cwd(), file);
  }

  @Post('git/stage')
  async gitStage(@Body() body: { cwd: string; files: string[]; unstage?: boolean; all?: boolean }) {
    await this.workspace.gitStage(body.cwd, body.files || [], !!body.unstage, !!body.all);
    return { status: 'ok' };
  }

  @Post('git/discard')
  async gitDiscard(@Body() body: { cwd: string; file: string; untracked?: boolean }) {
    await this.workspace.gitDiscard(body.cwd, body.file, !!body.untracked);
    return { status: 'ok' };
  }

  // ── Git operations (source-control sidebar) ─────────────────────────────

  @Post('git/init')
  async gitInit(@Body() body: { cwd: string }) {
    return this.workspace.gitInit(body.cwd || process.cwd());
  }

  @Post('git/commit')
  async gitCommit(@Body() body: { cwd: string; message: string; stageAll?: boolean }) {
    return this.workspace.gitCommit(body.cwd || process.cwd(), body.message || '', !!body.stageAll);
  }

  @Post('git/fetch')
  async gitFetch(@Body() body: { cwd: string }) {
    return this.workspace.gitFetch(body.cwd || process.cwd());
  }

  @Post('git/pull')
  async gitPull(@Body() body: { cwd: string }) {
    return this.workspace.gitPull(body.cwd || process.cwd());
  }

  @Post('git/push')
  async gitPush(@Body() body: { cwd: string; setUpstream?: boolean }) {
    return this.workspace.gitPush(body.cwd || process.cwd(), !!body.setUpstream);
  }

  @Get('git/stashes')
  async gitStashes(@Query('path') root: string) {
    return { stashes: await this.workspace.gitStashList(root || process.cwd()) };
  }

  @Post('git/stash/push')
  async gitStashPush(@Body() body: { cwd: string; message?: string }) {
    return this.workspace.gitStashPush(body.cwd || process.cwd(), body.message);
  }

  @Post('git/stash/apply')
  async gitStashApply(@Body() body: { cwd: string; name?: string }) {
    return this.workspace.gitStashApply(body.cwd || process.cwd(), body.name);
  }

  @Post('git/stash/pop')
  async gitStashPop(@Body() body: { cwd: string; name?: string }) {
    return this.workspace.gitStashPop(body.cwd || process.cwd(), body.name);
  }

  @Post('git/stash/drop')
  async gitStashDrop(@Body() body: { cwd: string; name: string }) {
    return this.workspace.gitStashDrop(body.cwd || process.cwd(), body.name);
  }

  @Get('git/branches')
  async gitBranches(@Query('path') root: string) {
    return { branches: await this.workspace.gitBranches(root || process.cwd()) };
  }

  @Post('git/branch/create')
  async gitCreateBranch(@Body() body: { cwd: string; name: string }) {
    return this.workspace.gitCreateBranch(body.cwd || process.cwd(), body.name);
  }

  @Post('git/branch/switch')
  async gitSwitchBranch(@Body() body: { cwd: string; name: string }) {
    return this.workspace.gitSwitchBranch(body.cwd || process.cwd(), body.name);
  }

  // ── Search ───────────────────────────────────────────────────────────────

  @Get('search/files')
  async searchFiles(@Query('root') root: string, @Query('query') query: string, @Req() req: any) {
    const ac = new AbortController();
    req.on('close', () => ac.abort());
    try {
      return { files: await this.workspace.searchFiles(root || process.cwd(), query || '', 200, ac.signal) };
    } catch {
      return { files: [] };
    }
  }

  @Get('search/content')
  async searchContent(
    @Query('root') root: string,
    @Query('query') query: string,
    @Query('caseSensitive') caseSensitive?: string,
    @Query('include') include?: string,
    @Req() req?: any,
  ) {
    const ac = new AbortController();
    req?.on('close', () => ac.abort());
    return this.workspace.searchContent(root || process.cwd(), query || '', {
      caseSensitive: caseSensitive === 'true',
      include: include || undefined,
      signal: ac.signal,
    });
  }

  // ── FS events (watch) ────────────────────────────────────────────────────

  @Sse('fs/events')
  fsEvents(@Query('root') root: string): Observable<MessageEvent> {
    return this.workspace.watchFs(root || process.cwd()).pipe(
      map((event) => ({ type: 'fs-event', data: JSON.stringify(event) }) as MessageEvent),
    );
  }
}
