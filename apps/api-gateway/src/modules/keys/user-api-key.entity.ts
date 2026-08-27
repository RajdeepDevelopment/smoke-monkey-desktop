import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export const PROVIDER_OPENROUTER = 'openrouter';
export const PROVIDER_NVIDIA = 'nvidia';
export const PROVIDER_OPENAI = 'openai';
export const PROVIDER_XAI = 'xai';
export const PROVIDER_GEMINI = 'gemini';
export const PROVIDER_OPENCODE = 'opencode';
export const PROVIDER_TAVILY = 'tavily';
export const PROVIDER_GOOGLE = 'google';
export const PROVIDER_BRAVE = 'brave';
export const PROVIDER_BING = 'bing';

export enum ApiKeyProvider {
  OpenRouter = 'openrouter',
  Nvidia = 'nvidia',
  OpenAI = 'openai',
  XAI = 'xai',
  Gemini = 'gemini',
  Opencode = 'opencode',
  Tavily = 'tavily',
  Google = 'google',
  Brave = 'brave',
  Bing = 'bing',
}

export const SUPPORTED_PROVIDERS = Object.values(ApiKeyProvider) as readonly string[];

@Entity('user_api_keys')
@Index(['userId', 'provider'], { unique: true })
export class UserApiKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  userId: string;

  @Column({ length: 32 })
  provider: string;

  @Column({ type: 'text', select: false })
  encryptedKey: string;

  @Column({ length: 16 })
  keyPrefix: string;

  @Column({ length: 4 })
  last4: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
