import { IsIn, IsNotEmpty, IsString, Length, Matches } from 'class-validator';

export const SECRET_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export class SaveSecretDto {
  @IsString()
  @IsNotEmpty()
  @Length(1, 4096)
  value: string;
}

export class SetSecretStatusDto {
  @IsString()
  @IsNotEmpty()
  @IsIn(['ok', 'invalid'])
  status: 'ok' | 'invalid';
}

export class SecretNameDto {
  @IsString()
  @IsNotEmpty()
  @Matches(SECRET_NAME_RE)
  name: string;
}