import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { OmniRouteService } from '../omniroute/omniroute.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

export interface AuthResult {
  accessToken: string;
  user: { id: string; email: string; name: string; createdAt: Date };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly jwt: JwtService,
    private readonly omniRoute: OmniRouteService,
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
    this.syncOmniRoute(dto.email, dto.password);
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
    this.syncOmniRoute(dto.email, dto.password);
    return this.buildAuthResult(user);
  }

  /**
   * Fire-and-forget sync: after a successful SM login/register, keep the
   * OmniRoute admin password aligned with the SM password and ensure the real
   * OmniRoute gateway is wired for the agent/chat. Never blocks the login
   * response (OmniRoute may be down or slow to start).
   */
  private syncOmniRoute(email: string, password: string): void {
    void this.omniRoute.syncForUser(password).then(
      () => {
        this.logger.log(`OmniRoute synced for ${email}`);
      },
      (err: unknown) => {
        this.logger.warn(
          `OmniRoute sync failed for ${email}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      },
    );
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
