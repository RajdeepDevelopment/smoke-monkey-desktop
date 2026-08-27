import { IsBoolean } from 'class-validator';

export class UpdateOmniRouteDto {
  @IsBoolean()
  enabled: boolean;
}
