import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseEnumPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ApiKeysService, UserKeySummary } from './api-keys.service';
import { SaveKeyDto } from './dto/save-key.dto';
import { ApiKeyProvider } from './user-api-key.entity';

/**
 * Per-user provider API keys. Everything here requires authentication —
 * unauthenticated users cannot read, write or use any key.
 */
@Controller('keys')
@UseGuards(JwtAuthGuard)
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  async list(@CurrentUser() user: { id: string }): Promise<{ keys: UserKeySummary[] }> {
    return { keys: await this.keys.listKeys(user.id) };
  }

  @Put(':provider')
  async save(
    @CurrentUser() user: { id: string },
    @Param('provider', new ParseEnumPipe(ApiKeyProvider)) provider: string,
    @Body() dto: SaveKeyDto,
  ) {
    return this.keys.setKey(user.id, provider, dto.apiKey);
  }

  @Delete(':provider')
  async remove(
    @CurrentUser() user: { id: string },
    @Param('provider', new ParseEnumPipe(ApiKeyProvider)) provider: string,
  ): Promise<{ status: 'ok' }> {
    await this.keys.removeKey(user.id, provider);
    return { status: 'ok' };
  }

  @Post(':provider/test')
  async test(
    @CurrentUser() user: { id: string },
    @Param('provider', new ParseEnumPipe(ApiKeyProvider)) provider: string,
  ) {
    const key = await this.keys.getKey(user.id, provider);
    if (!key) throw new NotFoundException('no saved key to test');
    const info = await this.keys.validateKey(provider, key);
    return { status: 'ok', info };
  }
}
