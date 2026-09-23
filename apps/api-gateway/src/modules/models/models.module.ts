import { Module } from '@nestjs/common';
import { ModelsController } from './models.controller';
import { OmniRouteModelHealthService } from './omniroute-health.service';

@Module({
  controllers: [ModelsController],
  providers: [OmniRouteModelHealthService],
  exports: [OmniRouteModelHealthService],
})
export class ModelsModule {}