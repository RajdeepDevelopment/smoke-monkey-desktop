import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class SaveKeyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  apiKey: string;
}
