import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  createSecretaryAuditEntry,
  normalizeSecretaryControl,
  parseSecretaryAudit,
  selectSecretaryTrigger,
  secretaryQuickPrompt
} from '../secretary-agent.js';

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

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('timed out waiting for condition');
}

async function request(url, cookie, pathname, options = {}) {
  const response = await fetch(`${url}${pathname}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json();
  return { response, data };
}

const firstAudit = createSecretaryAuditEntry(normalizeSecretaryControl(), { type: 'test.first', summary: 'first' });
const secondAudit = createSecretaryAuditEntry(firstAudit.control, { type: 'test.second', summary: 'second' });
assert.equal(secondAudit.entry.prevHash, firstAudit.entry.hash);
assert.deepEqual(parseSecretaryAudit(`${JSON.stringify(firstAudit.entry)}\n${JSON.stringify(secondAudit.entry)}\n`), [firstAudit.entry, secondAudit.entry]);
assert.ok(secretaryQuickPrompt('focus').includes('三件事'));
const briefTrigger = selectSecretaryTrigger(normalizeSecretaryControl(), { now: new Date('2026-07-29T00:00:00.000Z'), pendingTaskCount: 0 });
assert.equal(briefTrigger.type, 'daily-brief');
const quietControl = normalizeSecretaryControl({
  signals: [{ id: 'normal-signal', title: 'normal', priority: 'normal', status: 'pending' }]
});
assert.equal(selectSecretaryTrigger(quietControl, { now: new Date('2026-07-29T15:00:00.000Z') }), null);
const urgentControl = normalizeSecretaryControl({
  signals: [{ id: 'urgent-signal', title: 'urgent', priority: 'urgent', status: 'pending' }]
});
assert.equal(selectSecretaryTrigger(urgentControl, { now: new Date('2026-07-29T15:00:00.000Z') }).type, 'event');

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cmc-secretary-check-'));
const dataDir = path.join(tempRoot, 'data');
const codexHome = path.join(tempRoot, 'codex');
const secretaryDir = path.join(tempRoot, 'secretary-agent');
const fakeCodex = path.join(tempRoot, 'fake-codex.js');
const argsLog = path.join(tempRoot, 'codex-args.jsonl');
const password = 'secretary-integration-password';
let child;

try {
  await mkdir(dataDir, { recursive: true });
  await mkdir(path.join(codexHome, 'skills'), { recursive: true });
  await writeFile(path.join(dataDir, 'admin-password.txt'), `${password}\n`, { mode: 0o600 });
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.CODEX_ARGS_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: '019f1111-2222-7333-8444-555566667777' }));
  console.log(JSON.stringify({ type: 'event_msg', payload: { type: 'exec_command_end', command: ['echo', 'secretary-check'], status: 'completed', aggregated_output: 'ok' } }));
  if (input.includes('今天最值得推进')) {
    setTimeout(() => console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'late result' } })), 5000);
    return;
  }
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'secretary integration reply' } }));
});
`, { mode: 0o700 });
  await chmod(fakeCodex, 0o700);

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: dataDir,
      CODEX_HOME: codexHome,
      CODEX_BIN: fakeCodex,
      CODEX_ARGS_LOG: argsLog,
      SKILL_ROOTS: path.join(codexHome, 'skills'),
      PROJECTS_ROOT: tempRoot,
      SECRETARY_PROJECT_DIR: secretaryDir,
      COOKIE_SECURE: '0',
      APP_UPDATE_MANIFEST_URL: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  await waitFor(async () => {
    try {
      return (await fetch(`${url}/api/healthz`)).ok;
    } catch {
      return false;
    }
  });

  const login = await request(url, '', '/api/login', { method: 'POST', body: JSON.stringify({ password }) });
  assert.equal(login.response.status, 200, output);
  const cookie = login.response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);

  const initial = await request(url, cookie, '/api/secretary');
  assert.equal(initial.response.status, 200);
  assert.equal(initial.data.session, null);

  const activated = await request(url, cookie, '/api/secretary/activate', { method: 'POST' });
  assert.equal(activated.response.status, 200);
  assert.equal(activated.data.session.kind, 'secretary');
  assert.equal(activated.data.session.autonomous, true);
  assert.equal(activated.data.session.sandbox, 'danger-full-access');
  assert.equal(activated.data.session.approval, 'never');

  const disabled = await request(url, cookie, '/api/secretary/settings', {
    method: 'PATCH',
    body: JSON.stringify({ enabled: false, checkIntervalMinutes: 5, timezone: 'Asia/Tokyo' })
  });
  assert.equal(disabled.response.status, 200);
  assert.equal(disabled.data.control.settings.enabled, false);
  assert.equal(disabled.data.control.settings.checkIntervalMinutes, 5);

  const wake = await request(url, cookie, '/api/secretary/wake', { method: 'POST', body: '{}' });
  assert.equal(wake.response.status, 202, output);
  await waitFor(async () => {
    const status = await request(url, cookie, '/api/secretary');
    return status.data.running === false && status.data.control.notifications.some((item) => item.type === 'completed');
  });

  const event = await request(url, cookie, '/api/secretary/events', {
    method: 'POST',
    body: JSON.stringify({ type: 'integration', title: 'handle integration event', detail: 'verify event routing', priority: 'urgent' })
  });
  assert.equal(event.response.status, 202);
  assert.equal(event.data.signal.status, 'pending');
  const enabled = await request(url, cookie, '/api/secretary/settings', {
    method: 'PATCH',
    body: JSON.stringify({ enabled: true })
  });
  assert.equal(enabled.response.status, 200);
  await waitFor(async () => {
    const status = await request(url, cookie, '/api/secretary');
    return status.data.control.signals.some((item) => item.id === event.data.signal.id && item.status === 'completed');
  });

  const quick = await request(url, cookie, '/api/secretary/quick-task', {
    method: 'POST',
    body: JSON.stringify({ kind: 'focus' })
  });
  assert.equal(quick.response.status, 202, output);
  await waitFor(async () => (await readFile(argsLog, 'utf8').catch(() => '')).includes('dangerously-bypass-approvals-and-sandbox'));

  const killed = await request(url, cookie, '/api/secretary/kill', { method: 'POST' });
  assert.equal(killed.response.status, 200);
  assert.equal(killed.data.control.killSwitch, true);
  await waitFor(async () => {
    const status = await request(url, cookie, '/api/secretary');
    return status.data.running === false;
  });

  const blocked = await request(url, cookie, `/api/sessions/${activated.data.session.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ prompt: 'must stay stopped', elevated: false })
  });
  assert.equal(blocked.response.status, 423);

  const resumed = await request(url, cookie, '/api/secretary/resume', { method: 'POST' });
  assert.equal(resumed.response.status, 200);
  assert.equal(resumed.data.control.killSwitch, false);

  const readNotifications = await request(url, cookie, '/api/secretary/notifications/read', { method: 'POST', body: '{}' });
  assert.equal(readNotifications.response.status, 200);
  assert.equal(readNotifications.data.unreadCount, 0);

  const sent = await request(url, cookie, `/api/sessions/${activated.data.session.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ prompt: 'integration complete', elevated: false })
  });
  assert.equal(sent.response.status, 202, output);
  await waitFor(async () => {
    const status = await request(url, cookie, '/api/secretary');
    return status.data.running === false && status.data.audit.length >= 6 ? status.data : null;
  });

  const auditText = await readFile(path.join(dataDir, 'secretary-audit.jsonl'), 'utf8');
  const audit = parseSecretaryAudit(auditText, 500);
  assert.ok(audit.some((entry) => entry.type === 'secretary.kill_switch.enabled'));
  assert.ok(audit.some((entry) => entry.type === 'run.exec.end'));
  for (let index = 1; index < audit.length; index += 1) {
    assert.equal(audit[index].prevHash, audit[index - 1].hash);
  }

  child.kill('SIGTERM');
  await once(child, 'exit');
  assert.equal(child.exitCode, 0, output);
  child = null;
  console.log('secretary agent checks passed');
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit').catch(() => {});
  }
  await rm(tempRoot, { recursive: true, force: true });
}
