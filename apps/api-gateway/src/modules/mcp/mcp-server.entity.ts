import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A user-configured MCP (Model Context Protocol) server. Each server is a
 * stdio JSON-RPC process (e.g. `npx -y @apify/actors-mcp-server@latest`) that
 * exposes tools to the agent. The user gives each server a short name and a
 * one-line description so the agent can activate/deactivate it like a
 * sub-context (max 3 active at once).
 */
@Entity('user_mcp_servers')
@Index(['userId'], {})
export class McpServer {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  userId: string;

  /** The agent-facing id used for sub-context ids: mcp_<id>. */
  @Column({ length: 120 })
  name: string;

  /** Short description surfaced to the agent/user. */
  @Column({ type: 'text', default: '' })
  description: string;

  /** Transport: "stdio" (spawn a command) or "http" (streamable HTTP server). */
  @Column({ length: 16, default: 'stdio' })
  transport: 'stdio' | 'http';

  /** Executable to spawn (e.g. "npx"). Empty for http transport. */
  @Column({ length: 255, default: '' })
  command: string;

  /** JSON-encoded argument list (e.g. ["-y", "@apify/actors-mcp-server@latest"]). */
  @Column({ type: 'text', nullable: true })
  argsJson: string | null;

  /** JSON-encoded env map merged into the child process env (e.g. APIFY_TOKEN). */
  @Column({ type: 'text', nullable: true })
  envJson: string | null;

  /** Endpoint URL for http-transport servers (e.g. https://mcp.miro.com/). */
  @Column({ type: 'text', nullable: true })
  url: string | null;

  /** OAuth client id from dynamic client registration (http servers). */
  @Column({ type: 'text', nullable: true })
  oauthClientId: string | null;

  /** OAuth client secret from DCR (http servers). */
  @Column({ type: 'text', nullable: true })
  oauthClientSecret: string | null;

  /** Scopes override sent during OAuth authorization (http servers, for
   *  providers that don't advertise scopes — e.g. Google Cloud MCP). */
  @Column({ type: 'text', nullable: true })
  oauthScopes: string | null;

  /** OAuth access token used as the Bearer credential (http servers). */
  @Column({ type: 'text', nullable: true })
  oauthAccessToken: string | null;

  /** Personal access token / API key (http servers without OAuth or DCR, e.g.
   *  mcp.render.com). Sent as `Authorization: Bearer`, bypasses OAuth. */
  @Column({ type: 'text', nullable: true })
  apiToken: string | null;

  /** OAuth refresh token (http servers). */
  @Column({ type: 'text', nullable: true })
  oauthRefreshToken: string | null;

  /** Epoch ms when the access token expires (http servers). */
  @Column({ type: 'bigint', nullable: true })
  oauthExpiresAt: string | null;

  /** Whether this server is eligible for the agent to connect during runs. */
  @Column({ default: true })
  enabled: boolean;

  /** Optional brand hint or emoji the LLM/user assigned for UI display. */
  @Column({ length: 64, nullable: true })
  icon: string | null;

  /** Stock category this server belongs to (from the stock catalog when added
   *  via the UI, or user-picked for manual adds). Used for category-wise search
   *  and for the category filter in inspect_mcp_stock. */
  @Column({ type: 'text', nullable: true })
  category: string | null;

  /** Search tags (aliases/keywords) so the agent can find this server when the
   *  task uses different words than its name/description. Stored as JSON. */
  @Column({ type: 'simple-json', nullable: true })
  tags: string[] | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}