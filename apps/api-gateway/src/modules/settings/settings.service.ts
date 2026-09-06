import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RedisService } from '../../common/services/redis.service';
import { User } from '../users/user.entity';

export interface WebSearchSettings {
  serverEnabled: boolean;
  enabled: boolean;
}

export interface OmniRouteSettings {
  serverEnabled: boolean;
  enabled: boolean;
}

/**
 * Per-user feature settings, stored as Redis flags (short-lived, mirrored like
 * user API keys). The server-level kill-switch (WEB_SEARCH_ENABLED /
 * OMNIROUTE_ENABLED env) is reported so the UI can explain why a toggle is
 * locked.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private readonly webSearchTtl = 60 * 60 * 24 * 30; // 30 days
  private readonly omnirouteTtl = 60 * 60 * 24 * 30; // 30 days

  constructor(
    private readonly redis: RedisService,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  private get useSqliteFlags(): boolean {
    return !this.redis.isAvailable();
  }

  webSearchKey(userId: string): string {
    return `rag:user_setting:${userId}:web_search`;
  }

  omnirouteKey(userId: string): string {
    return `rag:user_setting:${userId}:omniroute`;
  }

  serverWebSearchEnabled(): boolean {
    return process.env.WEB_SEARCH_ENABLED === 'true';
  }

  serverOmniRouteEnabled(): boolean {
    return process.env.OMNIROUTE_ENABLED === 'true';
  }

  async getWebSearch(userId: string): Promise<WebSearchSettings> {
    const serverEnabled = this.serverWebSearchEnabled();
    let enabled = false;
    if (serverEnabled) {
      if (this.useSqliteFlags) {
        const u = await this.users.findOne({ where: { id: userId } });
        enabled = u?.webSearchEnabled ?? true;
      } else {
        try {
          enabled = (await this.redis.get(this.webSearchKey(userId))) === '1';
        } catch (err) {
          this.logger.warn(`web search setting lookup failed: ${err}`);
        }
      }
    }
    return { serverEnabled, enabled };
  }

  async setWebSearch(userId: string, enabled: boolean): Promise<WebSearchSettings> {
    const serverEnabled = this.serverWebSearchEnabled();
    if (!serverEnabled) {
      return { serverEnabled, enabled: false };
    }
    if (this.useSqliteFlags) {
      await this.users.update(userId, { webSearchEnabled: enabled });
      return { serverEnabled, enabled };
    }
    try {
      if (enabled) {
        await this.redis.set(this.webSearchKey(userId), '1', this.webSearchTtl);
      } else {
        await this.redis.del(this.webSearchKey(userId));
      }
    } catch (err) {
      this.logger.warn(`web search setting write failed: ${err}`);
      throw err;
    }
    return { serverEnabled, enabled };
  }

  async getOmniRoute(userId: string): Promise<OmniRouteSettings> {
    const serverEnabled = this.serverOmniRouteEnabled();
    let enabled = false;
    if (serverEnabled) {
      if (this.useSqliteFlags) {
        const u = await this.users.findOne({ where: { id: userId } });
        enabled = u?.omnirouteEnabled ?? true;
      } else {
        try {
          enabled = (await this.redis.get(this.omnirouteKey(userId))) === '1';
        } catch (err) {
          this.logger.warn(`omniroute setting lookup failed: ${err}`);
        }
      }
    }
    return { serverEnabled, enabled };
  }

  async setOmniRoute(userId: string, enabled: boolean): Promise<OmniRouteSettings> {
    const serverEnabled = this.serverOmniRouteEnabled();
    if (!serverEnabled) {
      return { serverEnabled, enabled: false };
    }
    if (this.useSqliteFlags) {
      await this.users.update(userId, { omnirouteEnabled: enabled });
      return { serverEnabled, enabled };
    }
    try {
      if (enabled) {
        await this.redis.set(this.omnirouteKey(userId), '1', this.omnirouteTtl);
      } else {
        await this.redis.del(this.omnirouteKey(userId));
      }
    } catch (err) {
      this.logger.warn(`omniroute setting write failed: ${err}`);
      throw err;
    }
    return { serverEnabled, enabled };
  }

private readonly onboardingKey = (userId: string): string =>
    `rag:user_setting:${userId}:onboarding_completed`;

async getOnboarding(userId: string): Promise<{ completed: boolean }> {
    if (this.useSqliteFlags) {
      const u = await this.users.findOne({ where: { id: userId } });
      return { completed: u?.onboardingCompleted ?? false };
    }
    try {
      return { completed: (await this.redis.get(this.onboardingKey(userId))) === '1' };
    } catch (err) {
      this.logger.warn(`onboarding setting lookup failed: ${err}`);
      return { completed: false };
    }
  }

  async setOnboarding(userId: string): Promise<{ completed: boolean }> {
    if (this.useSqliteFlags) {
      await this.users.update(userId, { onboardingCompleted: true });
      return { completed: true };
    }
    try {
      await this.redis.set(this.onboardingKey(userId), '1', 60 * 60 * 24 * 365);
    } catch (err) {
      this.logger.warn(`onboarding setting write failed: ${err}`);
      throw err;
    }
    return { completed: true };
  }
}
