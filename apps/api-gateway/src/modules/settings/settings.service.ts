import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../common/services/redis.service';

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

  constructor(private readonly redis: RedisService) {}

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
      try {
        enabled = (await this.redis.get(this.webSearchKey(userId))) === '1';
      } catch (err) {
        this.logger.warn(`web search setting lookup failed: ${err}`);
      }
    }
    return { serverEnabled, enabled };
  }

  async setWebSearch(userId: string, enabled: boolean): Promise<WebSearchSettings> {
    const serverEnabled = this.serverWebSearchEnabled();
    if (!serverEnabled) {
      return { serverEnabled, enabled: false };
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
      try {
        enabled = (await this.redis.get(this.omnirouteKey(userId))) === '1';
      } catch (err) {
        this.logger.warn(`omniroute setting lookup failed: ${err}`);
      }
    }
    return { serverEnabled, enabled };
  }

  async setOmniRoute(userId: string, enabled: boolean): Promise<OmniRouteSettings> {
    const serverEnabled = this.serverOmniRouteEnabled();
    if (!serverEnabled) {
      return { serverEnabled, enabled: false };
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
}
