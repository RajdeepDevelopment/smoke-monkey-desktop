import { IsBoolean } from 'class-validator';

export class UpdateWebSearchDto {
  @IsBoolean()
  enabled: boolean;
}
