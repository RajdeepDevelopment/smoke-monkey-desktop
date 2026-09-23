import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateShareConfigDto {
  @IsString()
  @IsOptional()
  @MaxLength(120)
  projectName?: string;

  @IsString()
  @IsOptional()
  accountId?: string;

  @IsString()
  @IsOptional()
  apiToken?: string;

  @IsString()
  @IsOptional()
  @MaxLength(253)
  tunnelHostname?: string;

  @IsString()
  @IsOptional()
  tunnelId?: string;

  @IsString()
  @IsOptional()
  outputDir?: string;

  @IsString()
  @IsOptional()
  pagesProjectName?: string;
}