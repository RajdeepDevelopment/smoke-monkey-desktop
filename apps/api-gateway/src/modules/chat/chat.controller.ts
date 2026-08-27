import {
  Body,
  Controller,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ChatService } from './chat.service';
import { ChatDto } from './dto/chat.dto';

@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post('stream')
  async stream(
    @CurrentUser() user: { id: string },
    @Body() dto: ChatDto,
    @Res() res: Response,
    @Req() req: Request,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    await this.chat.streamChat(user.id, dto, res, req);
  }
}
