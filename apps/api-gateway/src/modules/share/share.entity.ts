import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Per-user hosting & sharing configuration for Smoke Monkey. Stores the pieces
 * needed to run Cloudflare Quick Tunnels, persistent (named) tunnels, and
 * deploys to Cloudflare Pages/Workers. OAuth credentials/tokens are encrypted
 * at rest — see ShareService.
 */
@Entity('user_share_configs')
@Index(['userId'], {})
export class ShareConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  userId: string;

  /** Display name (e.g. "my-site"). */
  @Column({ length: 120, default: '' })
  projectName: string;

  /** Cloudflare account id used for Pages deploy targets. */
  @Column({ type: 'text', nullable: true })
  accountId: string | null;

  /** Cloudflare API token (encrypted) used for Pages deploy / DNS. */
  @Column({ type: 'text', nullable: true })
  apiTokenEnc: string | null;

  /** Desired public hostname for a persistent tunnel (e.g. app.example.com). */
  @Column({ type: 'text', nullable: true })
  tunnelHostname: string | null;

  /** Named tunnel id for persistent tunnels. */
  @Column({ type: 'text', nullable: true })
  tunnelId: string | null;

  /** Absolute path to the built static output to deploy (e.g. web/out). */
  @Column({ type: 'text', default: '' })
  outputDir: string;

  /** Target Cloudflare project name for Pages deployments. */
  @Column({ type: 'text', nullable: true })
  pagesProjectName: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}