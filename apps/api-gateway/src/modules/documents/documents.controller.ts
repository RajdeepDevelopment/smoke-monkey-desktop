import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { DocumentsService } from './documents.service';

@Controller('documents')
@UseGuards(JwtAuthGuard)
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @CurrentUser() user: { id: string },
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.documents.upload(user.id, file);
  }

  @Get()
  list(@CurrentUser() user: { id: string }) {
    return this.documents.listForUser(user.id);
  }

  @Get(':id')
  get(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.documents.getForUser(user.id, id);
  }

  @Delete(':id')
  remove(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.documents.remove(user.id, id);
  }
}
