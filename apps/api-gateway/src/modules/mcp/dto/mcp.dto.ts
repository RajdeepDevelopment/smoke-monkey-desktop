import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  MaxLength,
} from 'class-validator';

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
  @IsBoolean()
  enabled?: boolean;
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
  @IsBoolean()
  enabled?: boolean;
}