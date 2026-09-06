import { Global, Module } from '@nestjs/common';
import { OmniRouteService } from './omniroute.service';

@Global()
@Module({
  providers: [OmniRouteService],
  exports: [OmniRouteService],
})
export class OmniRouteModule {}
