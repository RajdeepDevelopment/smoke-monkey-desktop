import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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
