import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class PlaygroundRetrieveDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  message: string;

  @IsOptional()
  @IsIn(['fast', 'balanced', 'deep'])
  mode?: 'fast' | 'balanced' | 'deep';

  @IsOptional()
  @IsString()
  @MaxLength(32)
  provider?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  model?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  documentIds?: string[];
}
