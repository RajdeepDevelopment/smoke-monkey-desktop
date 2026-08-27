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

export class ChatDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  message: string;

  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  provider?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  model?: string;

  @IsOptional()
  @IsIn(['fast', 'balanced', 'deep'])
  mode?: 'fast' | 'balanced' | 'deep';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  documentIds?: string[];
}
