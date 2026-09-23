import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateMcpServerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsString()
  @IsOptional()
  @Length(0, 512)
  description?: string;

  @IsIn(['stdio', 'http'])
  @IsOptional()
  transport?: 'stdio' | 'http';

  @IsString()
  @IsOptional()
  @MaxLength(255)
  command?: string;

  @IsOptional()
  @IsArray()
  args?: string[];

  @IsOptional()
  env?: Record<string, string>;

  @IsOptional()
  @IsUrl({ require_tld: false })
  url?: string;

  @IsOptional()
  @IsString()
  oauthClientId?: string;

  @IsOptional()
  @IsString()
  oauthClientSecret?: string;

  @IsOptional()
  @IsString()
  oauthScopes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  /** Personal access token / API key, sent as `Authorization: Bearer` for
   *  http servers that don't support OAuth dynamic client registration. */
  apiToken?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsString()
  @IsOptional()
  @MaxLength(64)
  icon?: string;

  @IsString()
  @IsOptional()
  @MaxLength(120)
  category?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @MaxLength(40, { each: true })
  tags?: string[];
}

export class UpdateMcpServerDto {
  @IsString()
  @IsOptional()
  @MaxLength(120)
  name?: string;

  @IsString()
  @IsOptional()
  @Length(0, 512)
  description?: string;

  @IsIn(['stdio', 'http'])
  @IsOptional()
  transport?: 'stdio' | 'http';

  @IsString()
  @IsOptional()
  @MaxLength(255)
  command?: string;

  @IsOptional()
  @IsArray()
  args?: string[];

  @IsOptional()
  env?: Record<string, string>;

  @IsOptional()
  @IsUrl({ require_tld: false })
  url?: string;

  @IsOptional()
  @IsString()
  oauthClientId?: string;

  @IsOptional()
  @IsString()
  oauthClientSecret?: string;

  @IsOptional()
  @IsString()
  oauthScopes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  apiToken?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsString()
  @IsOptional()
  @MaxLength(64)
  icon?: string;

  @IsString()
  @IsOptional()
  @MaxLength(120)
  category?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @MaxLength(40, { each: true })
  tags?: string[];
}

export const MCP_BATCH_MAX = 8;

export class CreateManyMcpServersDto {
  @IsArray()
  @ArrayMaxSize(MCP_BATCH_MAX)
  @ValidateNested({ each: true })
  @Type(() => CreateMcpServerDto)
  servers: CreateMcpServerDto[];
}