import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OmniRouteService, OmniRouteStatusInfo } from '../omniroute/omniroute.service';
import { UpdateWebSearchDto } from './dto/update-web-search.dto';
import { UpdateOmniRouteDto } from './dto/update-omniroute.dto';
import { OmniRouteSettings, SettingsService, WebSearchSettings } from './settings.service';

@Controller('settings')
@UseGuards(JwtAuthGuard)
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly omniRoute: OmniRouteService,
  ) {}

  @Get()
  async get(@CurrentUser() user: { id: string }): Promise<{
    webSearch: WebSearchSettings;
    omniroute: OmniRouteSettings;
  }> {
    return {
      webSearch: await this.settings.getWebSearch(user.id),
      omniroute: await this.settings.getOmniRoute(user.id),
    };
  }

  @Put('web-search')
  async setWebSearch(
    @CurrentUser() user: { id: string },
    @Body() dto: UpdateWebSearchDto,
  ): Promise<{ webSearch: WebSearchSettings }> {
    return { webSearch: await this.settings.setWebSearch(user.id, dto.enabled) };
  }

  @Put('omniroute')
  async setOmniRoute(
    @CurrentUser() user: { id: string },
    @Body() dto: UpdateOmniRouteDto,
  ): Promise<{ omniroute: OmniRouteSettings }> {
    return { omniroute: await this.settings.setOmniRoute(user.id, dto.enabled) };
  }

  /** Live OmniRoute provisioning lifecycle (Initializing… / Ready / error). */
  @Get('omniroute/status')
  async getOmniRouteStatus(
    @CurrentUser() user: { id: string },
  ): Promise<OmniRouteStatusInfo & { serverEnabled: boolean }> {
    return {
      ...this.omniRoute.statusInfo,
      serverEnabled: this.settings.serverOmniRouteEnabled(),
    };
  }

  @Get('onboarding')
  async getOnboarding(
    @CurrentUser() user: { id: string },
  ): Promise<{ completed: boolean }> {
    return this.settings.getOnboarding(user.id);
  }

  @Put('onboarding')
  async setOnboarding(
    @CurrentUser() user: { id: string },
  ): Promise<{ completed: boolean }> {
    return this.settings.setOnboarding(user.id);
  }
}
