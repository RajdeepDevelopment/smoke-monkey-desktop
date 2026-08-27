import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

export interface AuthResult {
  accessToken: string;
  user: { id: string; email: string; name: string; createdAt: Date };
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResult> {
    const existing = await this.users.findOne({
      where: { email: dto.email.toLowerCase() },
    });
    if (existing) {
      throw new ConflictException('email already registered');
    }
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.users.save(
      this.users.create({
        email: dto.email.toLowerCase(),
        name: dto.name,
        passwordHash,
      }),
    );
    return this.buildAuthResult(user);
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.users.findOne({
      where: { email: dto.email.toLowerCase() },
      select: ['id', 'email', 'name', 'passwordHash', 'createdAt'],
    });
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('invalid credentials');
    }
    return this.buildAuthResult(user);
  }

  async validateUserId(id: string): Promise<User | null> {
    return this.users.findOneBy({ id });
  }

  private buildAuthResult(user: User): AuthResult {
    return {
      accessToken: this.jwt.sign({ sub: user.id, email: user.email }),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt,
      },
    };
  }
}
