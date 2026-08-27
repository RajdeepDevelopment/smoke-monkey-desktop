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

  // ── Git ──────────────────────────────────────────────────────────────────

  @Get('git/status')
  async gitStatus(@Query('path') root: string) {
    return this.workspace.gitStatus(root || process.cwd());
  }

  @Get('git/diff-file')
  async gitDiffFile(@Query('path') root: string, @Query('file') file: string) {
    if (!file) throw new BadRequestException('file required');
    return this.workspace.gitDiffFile(root || process.cwd(), file);
  }

  @Post('git/stage')
  async gitStage(@Body() body: { cwd: string; files: string[]; unstage?: boolean }) {
    await this.workspace.gitStage(body.cwd, body.files || [], !!body.unstage);
    return { status: 'ok' };
  }

  @Post('git/discard')
  async gitDiscard(@Body() body: { cwd: string; file: string; untracked?: boolean }) {
    await this.workspace.gitDiscard(body.cwd, body.file, !!body.untracked);
    return { status: 'ok' };
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
