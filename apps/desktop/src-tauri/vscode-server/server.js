/**
 * VS Code Web Server for Smoke Monkey Desktop
 * Uses @vscode/test-web to serve a pre-built VS Code web instance.
 * No need to build Code OSS from source.
 */

const http = require('http');
const { spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

const PORT = process.env.VSCODE_SERVER_PORT || 8643;
const API_URL = process.env.SMOKE_MONKEY_API_URL || 'http://localhost:3000';
const WORKSPACE = process.env.VSCODE_WORKSPACE || path.join(os.homedir(), 'smoke-monkey-workspace');

// ── Terminal PTY management ──────────────────────────────────────────────

const terminals = new Map();

function createTerminal(id, cols = 80, rows = 24) {
  const shell = process.env.SHELL || '/bin/bash';
  const pty = spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.env.HOME || os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });

  const terminal = { id, pty, cols, rows, clients: new Set() };
  terminals.set(id, terminal);
  return terminal;
}

// ── Minimal WebSocket (RFC 6455) ─────────────────────────────────────────

function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return null; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-5AB9FC1B0944').digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  return socket;
}

function readWsFrame(buf) {
  if (buf.length < 2) return null;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;
  if (payloadLen === 126) { if (buf.length < 4) return null; payloadLen = buf.readUInt16BE(2); offset = 4; }
  else if (payloadLen === 127) { if (buf.length < 10) return null; payloadLen = Number(buf.readBigUInt64BE(2)); offset = 10; }
  const masked = (buf[1] & 0x80) !== 0;
  let maskKey = null;
  if (masked) { if (buf.length < offset + 4) return null; maskKey = buf.slice(offset, offset + 4); offset += 4; }
  if (buf.length < offset + payloadLen) return null;
  let payload = buf.slice(offset, offset + payloadLen);
  if (masked) { for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4]; }
  return { opcode: buf[0] & 0x0f, payload: payload.toString('utf8'), totalLength: offset + payloadLen };
}

function sendWsText(socket, text) {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(2);
  header[0] = 0x81;
  if (payload.length < 126) {
    header[1] = payload.length;
    socket.write(Buffer.concat([header, payload]));
  } else if (payload.length < 65536) {
    header[1] = 126;
    const len = Buffer.alloc(2); len.writeUInt16BE(payload.length);
    socket.write(Buffer.concat([header, len, payload]));
  } else {
    header[1] = 127;
    const len = Buffer.alloc(8); len.writeBigUInt64BE(BigInt(payload.length));
    socket.write(Buffer.concat([header, len, payload]));
  }
}

// ── Terminal message handler ─────────────────────────────────────────────

function handleTerminalMessage(msg, socket, setTerminalId) {
  switch (msg.type) {
    case 'create': {
      const id = msg.id || `term-${Date.now()}`;
      setTerminalId(id);
      const terminal = createTerminal(id, msg.cols || 80, msg.rows || 24);
      terminal.clients.add(socket);
      terminal.pty.stdout.on('data', (data) => {
        sendWsText(socket, JSON.stringify({ type: 'output', id, data: data.toString() }));
      });
      terminal.pty.stderr.on('data', (data) => {
        sendWsText(socket, JSON.stringify({ type: 'output', id, data: data.toString() }));
      });
      terminal.pty.on('exit', (code) => {
        sendWsText(socket, JSON.stringify({ type: 'exit', id, code }));
      });
      sendWsText(socket, JSON.stringify({ type: 'created', id, pid: terminal.pty.pid }));
      break;
    }
    case 'input': {
      const t = terminals.get(msg.id || terminals.keys().next().value);
      if (t) t.pty.stdin.write(msg.data);
      break;
    }
    case 'resize': {
      const t = terminals.get(msg.id || terminals.keys().next().value);
      if (t) { t.cols = msg.cols; t.rows = msg.rows; }
      break;
    }
    case 'kill': {
      const t = terminals.get(msg.id || terminals.keys().next().value);
      if (t) { t.pty.kill(); terminals.delete(t.id); }
      break;
    }
  }
}

// ── Start @vscode/test-web as a child process ────────────────────────────

function startVscodeTestWeb() {
  // Find @vscode/test-web
  const possiblePaths = [
    path.join(__dirname, '../../../../node_modules/@vscode/test-web/out/index.js'),
    path.join(__dirname, '../../../../../node_modules/@vscode/test-web/out/index.js'),
    path.join(process.env.HOME, '.npm/_npx/*/node_modules/@vscode/test-web/out/index.js'),
  ];

  let testWebPath = null;
  for (const p of possiblePaths) {
    const expanded = p.replace(/\*/g, '');
    try {
      if (require('fs').existsSync(expanded)) {
        testWebPath = expanded;
        break;
      }
    } catch {}
  }

  if (!testWebPath) {
    console.log('[smokemonkey] @vscode/test-web not found, installing...');
    const install = spawn('npx', ['-y', '@vscode/test-web', '--help'], {
      stdio: 'inherit',
      shell: true,
    });
    install.on('exit', () => {
      console.log('[smokemonkey] Installed. Restart the server.');
      process.exit(0);
    });
    return;
  }

  console.log(`[smokemonkey] Starting VS Code web from ${testWebPath}`);

  const args = [
    testWebPath,
    '--port', String(PORT),
    '--host', '127.0.0.1',
    '--quality', 'stable',
    '--archive', `${WORKSPACE}`,
  ];

  const child = spawn(process.execPath, args, {
    stdio: 'inherit',
    env: { ...process.env },
  });

  child.on('exit', (code) => {
    console.log(`[smokemonkey] VS Code web exited with code ${code}`);
    process.exit(code || 0);
  });

  return child;
}

// ── Main: intercept upgrade requests before forwarding to test-web ───────

// Since @vscode/test-web handles its own HTTP, we run a WebSocket-only
// server alongside it for terminal PTY.
const WS_PORT = Number(PORT) + 1;

const wsServer = http.createServer((req, res) => {
  res.writeHead(426, { 'Content-Type': 'text/plain' });
  res.end('WebSocket upgrade required');
});

wsServer.on('upgrade', (req, socket, head) => {
  if (req.url !== '/terminal') { socket.destroy(); return; }

  const wsSocket = acceptWebSocket(req, socket);
  if (!wsSocket) return;

  let terminalId = null;
  let buf = Buffer.alloc(0);

  wsSocket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const frame = readWsFrame(buf);
      if (!frame) break;
      buf = buf.slice(frame.totalLength);
      if (frame.opcode === 0x08) { wsSocket.end(); return; }
      try {
        const msg = JSON.parse(frame.payload);
        handleTerminalMessage(msg, wsSocket, (id) => { terminalId = id; });
      } catch {}
    }
  });

  wsSocket.on('close', () => {
    if (terminalId) {
      const t = terminals.get(terminalId);
      if (t) {
        t.clients.delete(wsSocket);
        if (t.clients.size === 0) { t.pty.kill(); terminals.delete(terminalId); }
      }
    }
  });
});

wsServer.listen(WS_PORT, '127.0.0.1', () => {
  console.log(`[smokemonkey] Terminal WebSocket on ws://127.0.0.1:${WS_PORT}/terminal`);
});

// Start VS Code web
startVscodeTestWeb();

process.on('SIGINT', () => { for (const t of terminals.values()) t.pty.kill(); process.exit(0); });
process.on('SIGTERM', () => { for (const t of terminals.values()) t.pty.kill(); process.exit(0); });
