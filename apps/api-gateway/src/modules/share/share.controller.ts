import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ShareService } from './share.service';
import { UpdateShareConfigDto } from './dto/share.dto';

@Controller('share')
@UseGuards(JwtAuthGuard)
export class ShareController {
  constructor(private readonly share: ShareService) {}

  @Get()
  async status(@CurrentUser() user: { id: string }) {
    return this.share.status(user.id);
  }

  @Get('config')
  async config(@CurrentUser() user: { id: string }) {
    const cfg = await this.share.getConfig(user.id);
    return {
      id: cfg.id,
      projectName: cfg.projectName,
      accountId: cfg.accountId,
      tunnelHostname: cfg.tunnelHostname,
      tunnelId: cfg.tunnelId,
      outputDir: cfg.outputDir,
      pagesProjectName: cfg.pagesProjectName,
      hasApiToken: !!cfg.apiTokenEnc,
      createdAt: cfg.createdAt.toISOString(),
      updatedAt: cfg.updatedAt.toISOString(),
    };
  }

  @Post('config')
  async updateConfig(
    @CurrentUser() user: { id: string },
    @Body() dto: UpdateShareConfigDto,
  ) {
    const cfg = await this.share.updateConfig(user.id, dto);
    return {
      id: cfg.id,
      projectName: cfg.projectName,
      accountId: cfg.accountId,
      tunnelHostname: cfg.tunnelHostname,
      tunnelId: cfg.tunnelId,
      outputDir: cfg.outputDir,
      pagesProjectName: cfg.pagesProjectName,
      hasApiToken: !!cfg.apiTokenEnc,
    };
  }

  // ── Quick Tunnel (local hosting → public link) ────────────────────────

  @Post('tunnel/start')
  async startTunnel(
    @CurrentUser() user: { id: string },
    @Body() body: { url?: string },
  ) {
    if (body.url && !/^https?:\/\//.test(body.url)) {
      throw new BadRequestException('url must be an http(s) origin');
    }
    return this.share.startQuickTunnel(user.id, body.url ? { url: body.url } : undefined);
  }

  @Post('tunnel/stop')
  async stopTunnel() {
    return this.share.stopQuickTunnel();
  }

  // ── Persistent (named) tunnel ─────────────────────────────────────────

  @Post('tunnel/persistent/start')
  async startPersistent(@CurrentUser() user: { id: string }) {
    return this.share.startPersistentTunnel(user.id);
  }

  @Post('tunnel/persistent/stop')
  async stopPersistent() {
    return this.share.stopPersistentTunnel();
  }

  // ── Deploy to Cloudflare Pages/Workers ────────────────────────────────

  @Post('deploy/pages')
  async deployPages(
    @CurrentUser() user: { id: string },
    @Body() body: { projectName?: string },
  ) {
    return this.share.deployPages(user.id, body.projectName);
  }

  // ── Wrangler OAuth login ──────────────────────────────────────────────

  @Post('wrangler/login')
  async wranglerLogin() {
    return this.share.wranglerLogin();
  }

  @Post('wrangler/logout')
  async wranglerLogout() {
    return this.share.wranglerLogout();
  }
}