import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { existsSync } from 'fs';
import * as path from 'path';

/**
 * Locate a build of the web frontend the gateway can serve so a shared tunnel
 * origin presents the full app (UI + /api) instead of a bare API.
 */
function resolveWebBuildDir(): string | null {
  const root = process.env.PROJECT_ROOT || process.cwd();
  const candidates = [
    process.env.SM_WEB_OUT,
    path.join(root, 'apps/web/out'),
    path.join(root, 'out'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (c && existsSync(path.join(c, 'index.html'))) return c;
    } catch {}
  }
  return null;
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Serve the static web build (if present) so a single origin hosts both the
  // UI and the /api routes — required for Cloudflare Quick Tunnel sharing.
  const webDir = resolveWebBuildDir();
  if (webDir) {
    const express = require('express') as typeof import('express');
    const serveStatic = express.static(webDir, { index: 'index.html' });
    app.use((req: any, res: any, next: any) => {
      if (req.path.startsWith('/api')) return next();
      return serveStatic(req, res, next);
    });
    console.log(`api-gateway serving web build from ${webDir}`);
  } else {
    console.log('api-gateway: no web build found (shared links expose API only)');
  }

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  // Enable WebSocket adapter
  app.useWebSocketAdapter(new WsAdapter(app));

  const origins = (process.env.CORS_ORIGINS || 'http://localhost:3001,tauri://localhost,https://tauri.localhost')
    .split(',')
    .map((s) => s.trim());
  app.enableCors({ origin: origins, credentials: true });

  const port = Number(process.env.PORT || process.env.API_PORT || 8642);
  // Bind explicitly: Node's default pick can end up IPv6-only, which breaks
  // every hardcoded 127.0.0.1 client (Tauri shell, health checks).
  await app.listen(port, '0.0.0.0');
  console.log(`api-gateway listening on http://localhost:${port}`);
}

void bootstrap();
