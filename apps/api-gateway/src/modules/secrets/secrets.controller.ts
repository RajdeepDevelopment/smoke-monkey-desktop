import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { SaveSecretDto } from './dto/secrets.dto';
import { SECRET_HUGGING_FACE } from './user-secret.entity';
import {
  HuggingFaceStatusInfo,
  SecretSummary,
  SecretsService,
} from './secrets.service';

/**
 * Secret Manager endpoints. The agent can read/write/update these through the
 * secret_manager tool (always gated by explicit user approval); these REST
 * endpoints are the user's own management surface (used by the Settings page).
 */
@Controller('secrets')
@UseGuards(JwtAuthGuard)
export class SecretsController {
  constructor(private readonly secrets: SecretsService) {}

  @Get()
  async list(@CurrentUser() user: { id: string }): Promise<{ secrets: SecretSummary[] }> {
    return { secrets: await this.secrets.listSecrets(user.id) };
  }

  @Get('huggingface/status')
  async huggingFaceStatus(@CurrentUser() user: { id: string }): Promise<HuggingFaceStatusInfo> {
    return this.secrets.getHuggingFaceStatus(user.id);
  }

  @Put(':name')
  async save(
    @CurrentUser() user: { id: string },
    @Param('name') name: string,
    @Body() dto: SaveSecretDto,
  ): Promise<SecretSummary> {
    return this.secrets.setSecret(user.id, sanitizeName(name), dto.value);
  }

  @Delete(':name')
  async remove(
    @CurrentUser() user: { id: string },
    @Param('name') name: string,
  ): Promise<{ status: 'ok' }> {
    await this.secrets.removeSecret(user.id, sanitizeName(name));
    return { status: 'ok' };
  }

  @Post(':name/test')
  async test(
    @CurrentUser() user: { id: string },
    @Param('name') name: string,
  ): Promise<{ status: 'ok' | 'invalid' }> {
    const clean = sanitizeName(name);
    const value = await this.secrets.getSecret(user.id, clean);
    if (value === null) throw new BadRequestException(`no secret named "${clean}" saved`);
    if (clean === SECRET_HUGGING_FACE) {
      return { status: await this.secrets.validateHuggingFaceToken(value) };
    }
    return { status: 'ok' };
  }
}

function sanitizeName(name: string): string {
  const clean = String(name || '').trim().toLowerCase();
  if (!clean) throw new BadRequestException('secret name is required');
  return clean;
}