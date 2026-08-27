import { Controller, Get, Logger, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@Controller('analytics')
@UseGuards(JwtAuthGuard)
export class AnalyticsController {
  private readonly logger = new Logger(AnalyticsController.name);
  private readonly ragUrl = process.env.RAG_SERVICE_URL || 'http://localhost:8000';

  @Get('metrics')
  async metrics(): Promise<unknown> {
    let upstream: Response;
    try {
      upstream = await fetch(`${this.ragUrl}/api/v1/metrics`, {
        headers: { 'content-type': 'application/json' },
      });
    } catch (err) {
      this.logger.error(`rag-service /metrics call failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException('metrics unavailable');
    }
    if (!upstream.ok) {
      this.logger.error(`rag-service /metrics responded with ${upstream.status}`);
      throw new ServiceUnavailableException('metrics unavailable');
    }
    return upstream.json();
  }
}
