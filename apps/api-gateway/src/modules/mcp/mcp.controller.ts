import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { McpService } from './mcp.service';
import { CreateMcpServerDto, UpdateMcpServerDto } from './dto/mcp.dto';
import { Response } from 'express';

@Controller('mcp')
@UseGuards(JwtAuthGuard)
export class McpController {
  constructor(private readonly mcp: McpService) {}

  @Get()
  async list(@CurrentUser() user: { id: string }) {
    const servers = await this.mcp.listServers(user.id);
    return {
      servers: servers.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        transport: s.transport,
        command: s.command,
        args: s.argsJson ? JSON.parse(s.argsJson) : [],
        env: s.envJson ? Object.fromEntries(Object.keys(JSON.parse(s.envJson)).map((k) => [k, '***'])) : {},
        url: s.url,
        oauthConnected: s.transport === 'http' ? !!s.oauthAccessToken : undefined,
        oauthExpiresAt: s.oauthExpiresAt ? Number(s.oauthExpiresAt) : null,
        enabled: s.enabled,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
      })),
    };
  }

  @Post()
  async create(@CurrentUser() user: { id: string }, @Body() dto: CreateMcpServerDto) {
    const entity = await this.mcp.createServer(user.id, dto);
    return { id: entity.id, name: entity.name };
  }

  @Put(':id')
  async update(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: UpdateMcpServerDto,
  ) {
    const entity = await this.mcp.updateServer(id, user.id, dto);
    return { id: entity.id, name: entity.name };
  }

  @Delete(':id')
  async remove(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    await this.mcp.deleteServer(id, user.id);
    return { status: 'ok' as const };
  }

  @Post(':id/test')
  async test(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    return this.mcp.testConnection(id, user.id);
  }

  // ── OAuth for remote MCP servers ───────────────────────────────────────

  @Post(':id/oauth/start')
  async startOAuth(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    const port = Number(process.env.PORT || process.env.API_PORT || 8642);
    const host = process.env.OAUTH_HOST || '127.0.0.1';
    const redirectUri = `http://${host}:${port}/api/mcp/oauth/callback`;
    return this.mcp.startOAuthFlow(id, user.id, redirectUri);
  }

  @Post(':id/oauth/disconnect')
  async disconnectOAuth(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    await this.mcp.disconnectOAuth(id, user.id);
    return { status: 'ok' as const };
  }
}

// ── Public OAuth callback (browser redirect lands here — no JWT guard) ─────
// Mounted via separate non-authenticated controller
@Controller('mcp/oauth')
export class McpOAuthPublicController {
  constructor(private readonly mcp: McpService) {}

  @Get('callback')
  async oauthCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    if (!code || !state) {
      res.status(400).send(this.oauthPage(false, '', 'Connection failed'));
      return;
    }
    const server = await this.mcp.completeOAuthFlow(code, state);
    const ok = !!server;
    res.status(200).send(this.oauthPage(ok, server?.name ?? '', ok ? 'Connected!' : 'Connection failed', server?.id));
  }

  private oauthPage(ok: boolean, name: string, title: string, serverId?: string): string {
    const accent = ok ? '#10b981' : '#f59e0b';
    const icon = ok
      ? `<svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
           <circle cx="32" cy="32" r="32" fill="${accent}" fill-opacity="0.15"/>
           <circle cx="32" cy="32" r="24" fill="${accent}" fill-opacity="0.15"/>
           <path d="M24 32l6 6 12-12" stroke="${accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
         </svg>`
      : `<svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
           <circle cx="32" cy="32" r="32" fill="${accent}" fill-opacity="0.15"/>
           <circle cx="32" cy="32" r="24" fill="${accent}" fill-opacity="0.15"/>
           <path d="M32 24v10M32 38h.01" stroke="${accent}" stroke-width="3" stroke-linecap="round"/>
         </svg>`;
    const body = ok
      ? `<p style="margin:8px 0 2px;color:#e2e8f0;font-size:15px;font-weight:600">${name} is now connected.</p>
         <p style="margin:0 0 24px;color:#94a3b8;font-size:13px">Your agent can now use tools from this server.</p>
         <button onclick="window.close()" id="returnBtn"
                 style="margin-bottom:10px;width:100%;padding:10px 18px;border:none;border-radius:8px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .15s">
           Return to Smoke Monkey
         </button>
         <p style="margin:0;color:#64748b;font-size:12px">Or press <span style="color:#94a3b8">⌘W</span> / <span style="color:#94a3b8">Ctrl+W</span> to close this tab.</p>`
      : `<p style="margin:8px 0 24px;color:#94a3b8;font-size:13px">The session may have expired. Open Smoke Monkey and try connecting again.</p>
         <button onclick="window.close()"
                 style="width:100%;padding:10px 18px;border:none;border-radius:8px;background:#334155;color:#e2e8f0;font-size:14px;font-weight:500;cursor:pointer">
           Close Tab
         </button>`;
    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Smoke Monkey — OAuth</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='28' font-size='28'>🐒</text></svg>">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0b0f1a;color:#e2e8f0;padding:20px}
  .card{max-width:420px;width:100%;padding:36px 32px 28px;border-radius:14px;background:#131827;border:1px solid rgba(255,255,255,.06);box-shadow:0 4px 32px rgba(0,0,0,.45);text-align:center}
  h2{margin:12px 0 0;font-size:18px;font-weight:700;letter-spacing:-.01em}
</style></head><body>
<div class="card">
  <div style="display:flex;justify-content:center">${icon}</div>
  <h2 style="color:${accent}">${title}</h2>
  ${body}
</div>
${ok ? '<script>setTimeout(()=>window.close(),60000)</script>' : ''}
</body></html>`;
  }
}
