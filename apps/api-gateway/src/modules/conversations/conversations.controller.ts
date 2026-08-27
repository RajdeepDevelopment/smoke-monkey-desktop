import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ConversationsService } from './conversations.service';

export class CreateConversationDto {
  title?: string;
}

@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  list(@CurrentUser() user: { id: string }) {
    return this.conversations.listForUser(user.id);
  }

  @Post()
  create(
    @CurrentUser() user: { id: string },
    @Body() dto: CreateConversationDto,
  ) {
    return this.conversations.create(user.id, dto.title);
  }

  @Get(':id/messages')
  messages(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    return this.conversations.getMessages(user.id, id);
  }

  @Delete(':id')
  remove(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.conversations.remove(user.id, id);
  }
}
