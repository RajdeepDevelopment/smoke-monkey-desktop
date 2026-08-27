import { DataSource, EntitySchema, MixedList, DefaultNamingStrategy } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import * as fs from 'fs';

export class SnakeNamingStrategy extends DefaultNamingStrategy {
  columnName(propertyName: string, customName: string | undefined, embeddedPrefixes: string[]): string {
    const parts = [...embeddedPrefixes, customName ?? propertyName].filter(Boolean);
    return toSnakeCase(parts.join('_'));
  }
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

export interface TypeOrmOptions {
  entities: MixedList<Function | string | EntitySchema>;
}

function getDbPath(config?: ConfigService): string {
  const custom = config?.get('SQLITE_DB_PATH') || process.env.SQLITE_DB_PATH;
  if (custom) return custom;
  const dir = path.join(process.env.HOME || '.', '.smokemonkey');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'smokemonkey.db');
}

export function buildTypeOrmOptions(config: ConfigService, options: TypeOrmOptions) {
  const dbDriver = config.get('DB_DRIVER') || 'sqlite';

  if (dbDriver === 'sqlite') {
    return {
      type: 'sqlite' as const,
      database: getDbPath(config),
      entities: options.entities,
      namingStrategy: new SnakeNamingStrategy(),
      synchronize: true,
      logging: false,
    };
  }

  return {
    type: 'postgres' as const,
    host: config.get('POSTGRES_HOST') || 'localhost',
    port: Number(config.get('POSTGRES_PORT') || 5432),
    username: config.get('POSTGRES_USER') || 'rag',
    password: config.get('POSTGRES_PASSWORD') || 'rag_secret',
    database: config.get('POSTGRES_DB') || 'ragdb',
    entities: options.entities,
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: true,
    logging: false,
  };
}

export function buildSeedDataSource(entities: MixedList<Function | string | EntitySchema>): DataSource {
  const dbDriver = process.env.DB_DRIVER || 'sqlite';

  if (dbDriver === 'sqlite') {
    return new DataSource({
      type: 'sqlite',
      database: getDbPath(),
      entities,
      namingStrategy: new SnakeNamingStrategy(),
      synchronize: true,
    });
  }

  return new DataSource({
    type: 'postgres',
    host: process.env.POSTGRES_HOST || 'localhost',
    port: Number(process.env.POSTGRES_PORT || 5432),
    username: process.env.POSTGRES_USER || 'rag',
    password: process.env.POSTGRES_PASSWORD || 'rag_secret',
    database: process.env.POSTGRES_DB || 'ragdb',
    entities,
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: true,
  });
}
