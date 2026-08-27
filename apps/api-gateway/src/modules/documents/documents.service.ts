import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { NatsService } from '../../common/services/nats.service';
import { MinioService } from '../../common/services/minio.service';
import { DocumentEntity } from './document.entity';

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 10);
const ALLOWED_TYPES = ['application/pdf'];

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documents: Repository<DocumentEntity>,
    private readonly minio: MinioService,
    private readonly nats: NatsService,
  ) {}

  async upload(userId: string, file: UploadedFile) {
    if (!file) throw new BadRequestException('no file provided');
    if (!ALLOWED_TYPES.includes(file.mimetype)) {
      throw new BadRequestException('only PDF files are supported');
    }
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      throw new BadRequestException(`file exceeds ${MAX_UPLOAD_MB}MB limit`);
    }

    const id = randomUUID();
    const s3Key = `users/${userId}/${id}.pdf`;

    const doc = await this.documents.save(
      this.documents.create({
        id,
        userId,
        filename: file.originalname,
        s3Key,
        status: 'uploading',
        metadata: { size: file.size, contentType: file.mimetype },
      }),
    );

    try {
      await this.minio.upload(s3Key, file.buffer, file.mimetype);
      await this.nats.publish('documents.ingest', {
        jobId: randomUUID(),
        documentId: id,
        userId,
        filename: file.originalname,
        s3Key,
      });
    } catch (err) {
      this.logger.error(`upload pipeline failed for ${id}: ${err}`);
      await this.documents.update(id, { status: 'failed', error: String(err) });
      throw new BadRequestException('failed to queue document for ingestion');
    }

    return this.toDto(await this.documents.findOneBy({ id }));
  }

  async listForUser(userId: string) {
    const rows = await this.documents.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    return rows.map((d) => this.toDto(d));
  }

  async getForUser(userId: string, id: string) {
    const doc = await this.documents.findOneBy({ id, userId });
    if (!doc) throw new NotFoundException('document not found');
    return this.toDto(doc);
  }

  async remove(userId: string, id: string) {
    const doc = await this.documents.findOneBy({ id, userId });
    if (!doc) throw new NotFoundException('document not found');
    await this.minio.remove(doc.s3Key);
    await this.documents.delete({ id, userId });
    return { status: 'ok' };
  }

  private toDto(doc: DocumentEntity | null) {
    if (!doc) throw new NotFoundException('document not found');
    return {
      id: doc.id,
      userId: doc.userId,
      filename: doc.filename,
      status: doc.status,
      chunkCount: doc.chunkCount,
      error: doc.error,
      metadata: doc.metadata,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }
}
