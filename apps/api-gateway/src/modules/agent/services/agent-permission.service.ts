import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentPermission, PermissionEffect, PermissionScope } from '../entities/agent-permission.entity';

interface PermissionRule {
  tool: string;
  resource: string;
  effect: PermissionEffect;
  scope: PermissionScope;
}

interface AgentPermissionConfig {
  [agentId: string]: PermissionRule[];
}

const AGENT_PERMISSIONS: AgentPermissionConfig = {
  build: [
    { tool: '*', resource: '*', effect: 'allow', scope: 'workspace' },
  ],
  plan: [
    { tool: 'read_file', resource: '*', effect: 'allow', scope: 'workspace' },
    { tool: 'grep', resource: '*', effect: 'allow', scope: 'workspace' },
    { tool: 'glob', resource: '*', effect: 'allow', scope: 'workspace' },
    { tool: 'list_directory', resource: '*', effect: 'allow', scope: 'workspace' },
    { tool: 'git_status', resource: '*', effect: 'allow', scope: 'workspace' },
    { tool: 'git_diff', resource: '*', effect: 'allow', scope: 'workspace' },
    { tool: 'git_log', resource: '*', effect: 'allow', scope: 'workspace' },
    { tool: 'todo_write', resource: '*', effect: 'allow', scope: 'workspace' },
    { tool: 'ask_user', resource: '*', effect: 'allow', scope: 'workspace' },
    { tool: 'write_file', resource: '*', effect: 'deny', scope: 'workspace' },
    { tool: 'edit_file', resource: '*', effect: 'deny', scope: 'workspace' },
    { tool: 'replace_lines', resource: '*', effect: 'deny', scope: 'workspace' },
    { tool: 'apply_patch', resource: '*', effect: 'deny', scope: 'workspace' },
    { tool: 'delete_file', resource: '*', effect: 'deny', scope: 'workspace' },
    { tool: 'run_command', resource: '*', effect: 'deny', scope: 'workspace' },
  ],
  explore: [
    { tool: 'read_file', resource: '*', effect: 'allow', scope: 'workspace' },
    { tool: 'grep', resource: '*', effect: 'allow', scope: 'workspace' },
    { tool: 'glob', resource: '*', effect: 'allow', scope: 'workspace' },
    { tool: 'list_directory', resource: '*', effect: 'allow', scope: 'workspace' },
    { tool: 'git_status', resource: '*', effect: 'allow', scope: 'workspace' },
    { tool: 'git_diff', resource: '*', effect: 'allow', scope: 'workspace' },
    { tool: 'git_log', resource: '*', effect: 'allow', scope: 'workspace' },
    { tool: 'write_file', resource: '*', effect: 'deny', scope: 'workspace' },
    { tool: 'edit_file', resource: '*', effect: 'deny', scope: 'workspace' },
    { tool: 'replace_lines', resource: '*', effect: 'deny', scope: 'workspace' },
    { tool: 'apply_patch', resource: '*', effect: 'deny', scope: 'workspace' },
    { tool: 'delete_file', resource: '*', effect: 'deny', scope: 'workspace' },
    { tool: 'run_command', resource: '*', effect: 'deny', scope: 'workspace' },
  ],
  general: [
    { tool: '*', resource: '*', effect: 'allow', scope: 'workspace' },
  ],
};

@Injectable()
export class AgentPermissionService {
  private readonly logger = new Logger(AgentPermissionService.name);
  private pendingRequests = new Map<string, { resolve: (effect: PermissionEffect) => void; meta?: { userId?: string; workspacePath?: string; toolName?: string } }>();

  /**
   * Per-(userId, workspacePath) cache of DB-saved rules. evaluate() is called
   * for EVERY tool call of a run — without this cache that is one PostgreSQL
   * query per call (30 calls ⇒ 30 queries). Rules are loaded once per run
   * (preload) and re-validated by a short TTL; explicit invalidation keeps
   * user-initiated changes effective immediately.
   */
  private static readonly RULES_TTL_MS = 60_000;
  private rulesCache = new Map<string, { rules: PermissionRule[]; expiresAt: number }>();

  constructor(
    @InjectRepository(AgentPermission)
    private readonly repo: Repository<AgentPermission>,
  ) {}

  private cacheKey(userId: string, workspacePath: string): string {
    return `${userId}::${workspacePath}`;
  }

  /** Warms the rules cache at run start so the first tool call never blocks on the DB. */
  async preload(userId: string, workspacePath: string): Promise<void> {
    await this.getSavedRules(userId, workspacePath);
  }

  /** Drops cached rules — all workspaces, or one user's, or exactly one key. */
  invalidate(userId?: string, workspacePath?: string): void {
    if (userId && workspacePath) {
      this.rulesCache.delete(this.cacheKey(userId, workspacePath));
    } else if (userId) {
      const prefix = `${userId}::`;
      for (const key of this.rulesCache.keys()) {
        if (key.startsWith(prefix)) this.rulesCache.delete(key);
      }
    } else {
      this.rulesCache.clear();
    }
  }

  /** DB-saved rules with cache; static agent rules are pure code and need none. */
  private async getSavedRules(userId: string, workspacePath: string): Promise<PermissionRule[]> {
    const key = this.cacheKey(userId, workspacePath);
    const hit = this.rulesCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.rules;

    const rows = await this.repo.find({
      where: { userId, workspacePath },
      order: { createdAt: 'ASC' },
    });
    const rules: PermissionRule[] = rows.map((r) => ({
      tool: r.tool,
      resource: r.resource,
      effect: r.effect,
      scope: r.scope,
    }));
    this.rulesCache.set(key, { rules, expiresAt: Date.now() + AgentPermissionService.RULES_TTL_MS });
    return rules;
  }

  async evaluate(toolName: string, resource: string, agentId: string, userId: string, workspacePath: string): Promise<PermissionEffect> {
    const savedRules = await this.getSavedRules(userId, workspacePath);

    const agentRules = AGENT_PERMISSIONS[agentId] || AGENT_PERMISSIONS.build;
    const allRules = [...agentRules, ...savedRules];

    for (let i = allRules.length - 1; i >= 0; i--) {
      const rule = allRules[i];
      if (matchesPattern(toolName, rule.tool) && matchesPattern(resource, rule.resource)) {
        return rule.effect;
      }
    }

    return 'ask';
  }

  async saveRule(userId: string, tool: string, resource: string, effect: PermissionEffect, scope: PermissionScope, workspacePath: string): Promise<void> {
    const existing = await this.repo.findOne({ where: { userId, tool, resource, workspacePath } });
    if (existing) {
      existing.effect = effect;
      existing.scope = scope;
      await this.repo.save(existing);
    } else {
      await this.repo.save(this.repo.create({ userId, tool, resource, effect, scope, workspacePath }));
    }
    // New/changed rule must be visible to running and future runs immediately.
    this.invalidate(userId, workspacePath);
  }

  async getRules(userId: string, workspacePath: string): Promise<AgentPermission[]> {
    return this.repo.find({ where: { userId, workspacePath } });
  }

  async deleteRule(id: string): Promise<void> {
    const row = await this.repo.findOne({ where: { id } });
    await this.repo.delete(id);
    if (row) this.invalidate(row.userId, row.workspacePath);
  }

  registerPendingRequest(
    requestId: string,
    resolve: (effect: PermissionEffect) => void,
    meta?: { userId?: string; workspacePath?: string; toolName?: string },
  ): void {
    this.pendingRequests.set(requestId, { resolve, meta });
  }

  async resolvePendingRequest(requestId: string, effect: PermissionEffect): Promise<void> {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;
    this.pendingRequests.delete(requestId);
    pending.resolve(effect);
    // An explicit approval is remembered for this workspace so the same tool
    // doesn't prompt on every call ("don't ask again for <tool> here").
    if (effect === 'allow' && pending.meta?.userId && pending.meta.workspacePath && pending.meta.toolName) {
      try {
        await this.saveRule(pending.meta.userId, pending.meta.toolName, '*', 'allow', 'workspace', pending.meta.workspacePath);
      } catch (err) {
        this.logger.warn(`Failed to persist permission rule: ${err}`);
      }
    }
  }
}

function matchesPattern(value: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return value === pattern;
  const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
  return regex.test(value);
}
