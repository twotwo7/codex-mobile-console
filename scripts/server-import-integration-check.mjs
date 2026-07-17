import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`test server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/healthz`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for test server');
}

async function startServer({ dataDir, codexHome, port, codexBin }) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: dataDir,
      CODEX_HOME: codexHome,
      CODEX_BIN: codexBin,
      SKILL_ROOTS: path.join(codexHome, 'skills'),
      COOKIE_SECURE: '0',
      APP_UPDATE_MANIFEST_URL: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    await waitForServer(`http://127.0.0.1:${port}`, child);
  } catch (error) {
    child.kill('SIGKILL');
    throw new Error(`${error.message}\n${output}`);
  }
  return { child, output: () => output };
}

async function stopServer(server) {
  if (server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  const timeout = setTimeout(() => server.child.kill('SIGKILL'), 5000);
  await once(server.child, 'exit');
  clearTimeout(timeout);
  assert.equal(server.child.exitCode, 0, server.output());
}

async function login(url, password) {
  const response = await fetch(`${url}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password })
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  return cookie;
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cmc-import-check-'));
const dataDir = path.join(tempRoot, 'data');
const codexHome = path.join(tempRoot, 'codex');
const password = 'integration-test-password';
const codexSessionId = '019f0000-0000-7000-8000-000000000001';
const sessionDir = path.join(codexHome, 'sessions', '2026', '07', '16');
const sessionFile = path.join(sessionDir, `rollout-2026-07-16T00-00-00-${codexSessionId}.jsonl`);
const fakeCodex = path.join(tempRoot, 'fake-codex.js');

await mkdir(dataDir, { recursive: true });
await mkdir(sessionDir, { recursive: true });
await mkdir(path.join(codexHome, 'skills'), { recursive: true });
await writeFile(path.join(dataDir, 'admin-password.txt'), `${password}\n`, { mode: 0o600 });
await writeFile(fakeCodex, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: '019f0000-0000-7000-8000-000000000099' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'integration reply' } }));
});
`, { mode: 0o700 });
await chmod(fakeCodex, 0o700);
await writeFile(sessionFile, [
  JSON.stringify({
    timestamp: '2026-07-16T00:00:00.000Z',
    type: 'session_meta',
    payload: { id: codexSessionId, timestamp: '2026-07-16T00:00:00.000Z', cwd: '/root/Projects/integration-project' }
  }),
  JSON.stringify({
    timestamp: '2026-07-16T00:00:01.000Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: 'integration import' }
  })
].join('\n') + '\n');

let server;
try {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  server = await startServer({ dataDir, codexHome, port, codexBin: fakeCodex });
  const cookie = await login(url, password);
  const imports = await Promise.all(Array.from({ length: 16 }, async () => {
    const response = await fetch(`${url}/api/codex-sessions/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ codexSessionId })
    });
    assert.equal(response.status, 201);
    return (await response.json()).session;
  }));
  assert.equal(new Set(imports.map((session) => session.id)).size, 1);

  const createdResponse = await fetch(`${url}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ title: 'Chat integration', cwd: tempRoot })
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).session;
  const sendResponse = await fetch(`${url}/api/sessions/${created.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ prompt: 'hello integration', clientMessageId: 'integration-message' })
  });
  assert.equal(sendResponse.status, 202);
  const chatDeadline = Date.now() + 5000;
  let chatMessages = [];
  while (Date.now() < chatDeadline) {
    const chatResponse = await fetch(`${url}/api/sessions/${created.id}/messages?limit=100`, { headers: { cookie } });
    assert.equal(chatResponse.status, 200);
    const chat = await chatResponse.json();
    chatMessages = chat.messages || [];
    if (chat.session.status === 'idle' && chatMessages.some((message) => message.text === 'integration reply')) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(chatMessages.some((message) => message.text === 'integration reply'));
  assert.ok(chatMessages.some((message) => message.text === 'Codex run finished.'));
  await stopServer(server);
  server = null;

  const persisted = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'));
  const matching = Object.values(persisted.sessions || {}).filter((session) => session.codexSessionId === codexSessionId);
  assert.equal(matching.length, 1);

  const restartPort = await freePort();
  const restartUrl = `http://127.0.0.1:${restartPort}`;
  server = await startServer({ dataDir, codexHome, port: restartPort, codexBin: fakeCodex });
  const restartCookie = await login(restartUrl, password);
  const response = await fetch(`${restartUrl}/api/sessions`, { headers: { cookie: restartCookie } });
  assert.equal(response.status, 200);
  const sessions = (await response.json()).sessions;
  assert.equal(sessions.filter((session) => session.source === 'web' && session.codexSessionId === codexSessionId).length, 1);
  const restoredChat = sessions.find((session) => session.id === created.id);
  assert.ok(restoredChat);
  const restoredMessagesResponse = await fetch(`${restartUrl}/api/sessions/${created.id}/messages?limit=100`, { headers: { cookie: restartCookie } });
  const restoredMessages = (await restoredMessagesResponse.json()).messages || [];
  assert.ok(restoredMessages.some((message) => message.text === 'integration reply'));
  console.log('server import integration checks passed');
} finally {
  if (server) await stopServer(server).catch(() => server.child.kill('SIGKILL'));
  await rm(tempRoot, { recursive: true, force: true });
}
