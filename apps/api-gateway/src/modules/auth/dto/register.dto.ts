import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;
}
