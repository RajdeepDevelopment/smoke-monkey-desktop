import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PlaygroundService } from './playground.service';
import { PlaygroundRetrieveDto } from './dto/playground-retrieve.dto';

@Controller('playground')
@UseGuards(JwtAuthGuard)
export class PlaygroundController {
  constructor(private readonly playground: PlaygroundService) {}

  @Post('retrieve')
  retrieve(@CurrentUser() user: { id: string }, @Body() dto: PlaygroundRetrieveDto) {
    return this.playground.retrieve(user.id, dto);
  }
}
