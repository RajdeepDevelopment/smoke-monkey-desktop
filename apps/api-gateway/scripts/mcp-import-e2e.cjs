/* eslint-disable no-console */
// Manual E2E: boots the compiled API on a throwaway sqlite DB and exercises the
// new MCP import endpoint end to end (security validation + persistence + list).
// Run from apps/api-gateway:  node scripts/mcp-import-e2e.cjs
const path = require('path');
const os = require('os');
const fs = require('fs');
const { NestFactory } = require('@nestjs/core');
const { INestApplication } = require('@nestjs/platform-express');
const { WsAdapter } = require('@nestjs/platform-ws');
const { ValidationPipe } = require('@nestjs/common');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smokemonkey-e2e-'));
process.env.SQLITE_DB_PATH = path.join(tmpDir, 'e2e.db');
process.env.JWT_SECRET = 'e2e-test-secret';
process.env.NODE_ENV = 'test';

async function main() {
  const { AppModule } = require('../dist/app.module.js');
  const app = await NestFactory.create(AppModule);
  // Mirror main.ts so the WS gateway resolves its driver instead of falling
  // back to the (uninstalled) socket.io default.
  app.useWebSocketAdapter(new WsAdapter(app));
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.init();
  await app.listen(0);
  const addr = app.getHttpServer().address();
  const port = addr && typeof addr === 'object' ? addr.port : null;
  if (!port) throw new Error('no port');
  const base = `http://127.0.0.1:${port}`;

  const assert = require('assert');

  const post = async (url, body, token) => {
    const res = await fetch(`${base}${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const get = async (url, token) => {
    const res = await fetch(`${base}${url}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  const email = `e2e-${Date.now()}@test.dev`;
  const reg = await post('/api/auth/register', { email, name: 'E2E', password: 'password123' });
  assert.equal(reg.status, 201, `register: ${JSON.stringify(reg.json)}`);
  const token = reg.json.accessToken;
  assert.ok(token, 'register returned a token');

  const badPayload = { mcpServers: { ok: { command: 'npx', args: ['-y', 'some-mcp'] }, evil: { command: 'rm -rf /' }, dup: { command: 'npx' } } };
  const first = await post('/api/mcp/import', badPayload, token);
  assert.equal(first.status, 201, `import status: ${JSON.stringify(first.json)}`);
  assert.equal(first.json.created.length, 2, '2 valid created');
  assert.equal(first.json.errors.length, 1, '1 rejected entry');
  assert.ok(first.json.errors[0].includes('not allowed'), 'error names forbidden command');

  // cross-shape tests
  const arrReq = await post('/api/mcp/import', { servers: [{ name: 'github', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], icon: 'github' }] }, token);
  assert.equal(arrReq.json.created.length, 1, 'servers array form created');
  const singleReq = await post('/api/mcp/import', { name: 'brave', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], env: { BRAVE_API_KEY: 'key' }, icon: '🦁' }, token);
  assert.equal(singleReq.json.created.length, 1, 'single-object form created');
  const httpReq = await post('/api/mcp/import', { name: 'gcal', transport: 'http', url: 'https://www.googleapis.com/calendar/v3/mcp', oauthScopes: 'https://www.googleapis.com/auth/calendar.events' }, token);
  assert.equal(httpReq.json.created.length, 1, 'http form created');

  // duplicate → skipped, not overwritten
  const dupReq = await post('/api/mcp/import', { servers: [{ name: 'github', command: 'npx' }] }, token);
  assert.equal(dupReq.json.created.length, 0);
  assert.equal(dupReq.json.skipped.length, 1, 'duplicate skipped');

  // list reflects all 5 created + icon persisted
  const listing = await get('/api/mcp', token);
  assert.equal(listing.status, 200);
  const names = listing.json.servers.map((s) => s.name);
  for (const n of ['ok', 'dup', 'github', 'brave', 'gcal']) assert.ok(names.includes(n), `list has ${n}`);
  const gh = listing.json.servers.find((s) => s.name === 'github');
  const brave = listing.json.servers.find((s) => s.name === 'brave');
  const gcal = listing.json.servers.find((s) => s.name === 'gcal');
  assert.equal(gh.icon, 'github');
  assert.equal(brave.icon, '🦁');
  assert.equal(gcal.transport, 'http');
  assert.equal(gcal.url, 'https://www.googleapis.com/calendar/v3/mcp');
  // env value masked in list output ('***'), key retained for reference
  assert.equal(brave.env?.BRAVE_API_KEY, '***', 'env value masked');

  // unauth -> 401
  assert.equal((await get('/api/mcp')).status, 401, 'unauth list 401');

  console.log('E2E MCP IMPORT — ALL PASSED (5 servers created, 1 rejected, 1 duplicate skipped, icons + http persisted, env masked, 401 unauth)');
  console.log('servers:', names.join(', '));
  app.close().finally(() => process.exit(0));
}

main().catch((err) => {
  console.error('E2E FAILED:', err.message);
  console.error(err);
  process.exit(1);
});