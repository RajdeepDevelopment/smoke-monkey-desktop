import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export const SECRET_HUGGING_FACE = 'huggingface';

/**
 * A named per-user secret (the "Secret Manager"). The agent can read/write
 * these via the secret_manager tool, but ONLY after the user approves each
 * access (enforced by the agent permission system with an always-ask rule).
 * Values are AES-256-GCM encrypted at rest — never stored in plaintext.
 */
@Entity('user_secrets')
@Index(['userId', 'name'], { unique: true })
export class UserSecret {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  userId: string;

  @Column({ length: 64 })
  name: string;

  @Column({ type: 'text', select: false })
  encryptedValue: string;

  @Column({ length: 16 })
  keyPrefix: string;

  @Column({ length: 4 })
  last4: string;

  /**
   * Hugging Face token billing tier detected from whoami-v2 at save time:
   * 'free' (Basic account) | 'paid' (Pro / canPay with credits) | null (unknown).
   * Drives the model-availability rule injected into the agent prompt
   * (FREE tokens → only free-tier models; PAID tokens → all models).
   */
  @Column({ type: 'text', nullable: true })
  billingTier: 'free' | 'paid' | null;

  /** Detected account metadata JSON: { canPay, isPro, billingMode, periodEnd, name }. */
  @Column({ type: 'text', nullable: true })
  billingMeta: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}