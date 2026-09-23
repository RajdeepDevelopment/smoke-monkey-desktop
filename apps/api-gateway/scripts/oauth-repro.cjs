/* eslint-disable no-console */
// Reproduces the gcal/gdrive OAuth failure and prints the REAL underlying error
// by calling startOAuthFlow through the controller's service (bypassing the
// generic 500 filter). Run from apps/api-gateway: node scripts/oauth-repro.cjs
const path = require('path');
const os = require('os');
const fs = require('fs');
const { NestFactory } = require('@nestjs/core');
const { WsAdapter } = require('@nestjs/platform-ws');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smokemonkey-oauth-'));
process.env.SQLITE_DB_PATH = path.join(tmpDir, 'e2e.db');
process.env.JWT_SECRET = 'e2e-test-secret';
process.env.NODE_ENV = 'test';

async function main() {
  const { AppModule } = require('../dist/app.module.js');
  const app = await NestFactory.create(AppModule);
  app.useWebSocketAdapter(new WsAdapter(app));
  app.setGlobalPrefix('api');
  await app.init();
  await app.listen(0);
  const { McpService } = require('../dist/modules/mcp/mcp.service.js');
  const { AuthService } = require('../dist/modules/auth/auth.service.js');
  const mcpSvc = app.get(McpService);
  const authSvc = app.get(AuthService);

  const { user } = await authSvc.register({
    email: `oauth-${Date.now()}@test.dev`,
    name: 'OA',
    password: 'password123',
  });

  const results = [];
  for (const url of [
    'https://drive.googleapis.com/mcp',
    'https://www.googleapis.com/calendar/v3/mcp',
  ]) {
    try {
      const { discoverOAuthMetadata } = require('../dist/modules/mcp/mcp.service.js');
      const meta = await discoverOAuthMetadata(url, console);
      results.push({ url, step: 'discover', ok: true, meta: { issuer: meta.issuer, authorizationEndpoint: meta.authorizationEndpoint, tokenEndpoint: meta.tokenEndpoint, registrationEndpoint: meta.registrationEndpoint, resourceScopes: (meta.resourceScopes || []).slice(0, 3), scopesSupported: (meta.scopesSupported || []).slice(0, 3) } });
    } catch (err) {
      results.push({ url, step: 'discover', ok: false, error: err.message });
    }
  }

  // also attempt full startOAuthFlow with empty client credentials (the manual-OAuth preset path)
  for (const url of [
    'https://drive.googleapis.com/mcp',
    'https://www.googleapis.com/calendar/v3/mcp',
  ]) {
    try {
      const srv = await mcpSvc.createServer(user.id, { name: `oauth-test-${Math.random()}`.slice(0, 16), transport: 'http', url, oauthScopes: url.includes('calendar') ? 'https://www.googleapis.com/auth/calendar.events' : 'https://www.googleapis.com/auth/drive.readonly' });
      const out = await mcpSvc.startOAuthFlow(srv.id, user.id, 'http://127.0.0.1:8642/api/mcp/oauth/callback');
      results.push({ url, step: 'startOAuthFlow(no creds)', ok: true, authUrl: out.authUrl.slice(0, 90) + '…' });
    } catch (err) {
      results.push({ url, step: 'startOAuthFlow(no creds)', ok: false, error: err.message });
    }
  }

  // with user-supplied Google client creds → should produce a real authorize URL
  for (const url of ['https://drive.googleapis.com/mcp', 'https://www.googleapis.com/calendar/v3/mcp']) {
    try {
      const srv = await mcpSvc.createServer(user.id, { name: `oauth-cred-${Math.random()}`.slice(0, 18), transport: 'http', url, oauthScopes: 'https://www.googleapis.com/auth/drive.readonly', oauthClientId: 'CLIENT_ID.apps.googleusercontent.com', oauthClientSecret: 'dummy-secret' });
      const out = await mcpSvc.startOAuthFlow(srv.id, user.id, 'http://127.0.0.1:8642/api/mcp/oauth/callback');
      results.push({ url, step: 'startOAuthFlow(with creds)', ok: !!out.authUrl, authUrl: out.authUrl.slice(0, 110) + '…' });
    } catch (err) {
      results.push({ url, step: 'startOAuthFlow(with creds)', ok: false, error: err.message });
    }
  }

  // HTTP check: create a no-creds remote server via the real REST API and
  // POST oauth/start — must be a 400 with the actionable message, not a 500.
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  const token = (await authSvc.register({ email: `http-${Date.now()}@test.dev`, name: 'HTTP', password: 'password123' })).accessToken;
  const created = await fetch(`${base}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'oauth-http-test', transport: 'http', url: 'https://drive.googleapis.com/mcp', oauthScopes: 'https://www.googleapis.com/auth/drive.readonly' }),
  }).then((r) => r.json());
  const httpRes = await fetch(`${base}/api/mcp/${created.id}/oauth/start`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  const httpBody = await httpRes.json();
  results.push({
    url: 'POST /oauth/start (http)',
    step: `startOAuthHTTP ${httpRes.status}`,
    ok: httpRes.status === 400 && /Google Cloud client/.test(httpBody.message || ''),
    error: httpBody.message || JSON.stringify(httpBody),
  });

  for (const r of results) {
    console.log(r.ok ? `OK   ${r.step} ${r.url}\n     ${JSON.stringify(r.meta || r.authUrl)}` : `FAIL ${r.step} ${r.url}\n     ${r.error}`);
  }
  app.close().finally(() => process.exit(0));
}

main().catch((err) => { console.error('REPRO FAILED:', err); process.exit(1); });