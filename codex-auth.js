import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const SECRET_FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function cleanName(value, fallback = 'Codex 账号') {
  const name = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  return name || fallback;
}

function safeProfileId(value) {
  const id = String(value || '').trim().toLowerCase();
  return PROFILE_ID.test(id) ? id : '';
}

function maskSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 8) return `${text.slice(0, 2)}...${text.slice(-2)}`;
  return `${text.slice(0, 5)}...${text.slice(-4)}`;
}

function sanitizeOutput(value) {
  return String(value || '')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
    .replace(/(access[_-]?token|api[_-]?key|authorization)\s*[:=]\s*\S+/gi, '$1: ***')
    .slice(-4000);
}

function nowIso() { return new Date().toISOString(); }

export function createCodexAuthManager({ dataDir, codexHome, codexBin, codexNode, commandEnv, runningCount }) {
  const root = path.join(dataDir, 'codex-auth');
  const profilesRoot = path.join(root, 'profiles');
  const backupRoot = path.join(root, 'backups');
  const masterFile = path.join(root, 'master.key');
  const tasks = new Map();

  async function ensureLayout() {
    await mkdir(root, { recursive: true, mode: DIR_MODE });
    await mkdir(profilesRoot, { recursive: true, mode: DIR_MODE });
    await mkdir(backupRoot, { recursive: true, mode: DIR_MODE });
    try { await chmod(root, DIR_MODE); } catch {}
    if (!(await exists(masterFile))) await writeFile(masterFile, randomBytes(32), { mode: SECRET_FILE_MODE });
    try { await chmod(masterFile, SECRET_FILE_MODE); } catch {}
  }

  async function exists(file) {
    try { await stat(file); return true; } catch { return false; }
  }

  function homeFor(profile) { return profile?.id === 'default' ? codexHome : path.join(profilesRoot, profile.id); }
  function authFile(profile) { return path.join(homeFor(profile), 'auth.json'); }

  async function ensureProfileHome(profile) {
    await mkdir(homeFor(profile), { recursive: true, mode: DIR_MODE });
    try { await chmod(homeFor(profile), DIR_MODE); } catch {}
  }

  async function readAuth(profile) {
    try { return await readFile(authFile(profile), 'utf8'); } catch { return ''; }
  }

  async function execLogin(profile, args, input = '', timeoutMs = 90000) {
    await ensureProfileHome(profile);
    return new Promise((resolve) => {
      const command = codexBin.endsWith('.js') ? codexNode : codexBin;
      const commandArgs = codexBin.endsWith('.js') ? [codexBin, ...args] : args;
      const child = spawn(command, commandArgs, {
        cwd: homeFor(profile),
        detached: process.platform !== 'win32',
        env: { ...commandEnv(), CODEX_HOME: homeFor(profile) },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let stdout = ''; let stderr = ''; let done = false;
      const finish = (result) => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
      const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} finish({ code: null, timedOut: true, stdout, stderr }); }, timeoutMs);
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', (error) => finish({ code: null, error: error.message, stdout, stderr }));
      child.on('close', (code) => finish({ code, stdout, stderr }));
      if (input) child.stdin.write(input);
      child.stdin.end();
    });
  }

  async function status(profile) {
    const result = await execLogin(profile, ['login', 'status'], '', 15000);
    const text = `${result.stdout}\n${result.stderr}`.trim();
    const loggedIn = result.code === 0 && /logged in|authenticated|api key/i.test(text);
    const auth = await readAuth(profile);
    return {
      status: loggedIn ? 'logged_in' : auth ? 'unknown' : 'logged_out',
      detail: sanitizeOutput(text),
      keyHint: profile.mode === 'apikey' ? (profile.keyHint || '') : ''
    };
  }

  async function encryptedBackup(profile, reason = 'manual') {
    const plain = await readAuth(profile);
    if (!plain) return null;
    const master = await readFile(masterFile);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', master, iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const payload = Buffer.concat([Buffer.from('CMC1'), iv, cipher.getAuthTag(), encrypted]).toString('base64');
    const id = `${Date.now()}-${randomUUID()}`;
    const file = path.join(backupRoot, `${profile.id}-${id}.bin`);
    await writeFile(file, payload, { mode: SECRET_FILE_MODE });
    profile.lastBackupAt = nowIso();
    return { id, profileId: profile.id, createdAt: profile.lastBackupAt, reason, file };
  }

  async function listBackups(profileId) {
    const files = await readdir(backupRoot).catch(() => []);
    return files.filter((file) => file.startsWith(`${profileId}-`) && file.endsWith('.bin')).sort().reverse().slice(0, 20)
      .map((file) => ({ id: file.slice(profileId.length + 1, -4), profileId, createdAt: new Date(Number(file.slice(profileId.length + 1).split('-')[0])).toISOString(), file }));
  }

  async function restore(profile, backupId) {
    if (runningCount() > 0) { const error = new Error('codex_sessions_running'); error.code = 'codex_sessions_running'; throw error; }
    const file = path.join(backupRoot, `${profile.id}-${backupId}.bin`);
    if (!(await exists(file))) { const error = new Error('backup_not_found'); error.code = 'backup_not_found'; throw error; }
    const current = await readAuth(profile); if (current) await encryptedBackup(profile, 'before_restore');
    const raw = Buffer.from(await readFile(file, 'utf8'), 'base64');
    if (raw.subarray(0, 4).toString() !== 'CMC1') throw Object.assign(new Error('backup_corrupt'), { code: 'backup_corrupt' });
    const decipher = createDecipheriv('aes-256-gcm', await readFile(masterFile), raw.subarray(4, 16));
    decipher.setAuthTag(raw.subarray(16, 32));
    const plain = Buffer.concat([decipher.update(raw.subarray(32)), decipher.final()]);
    await ensureProfileHome(profile); await writeFile(authFile(profile), plain, { mode: SECRET_FILE_MODE }); await chmod(authFile(profile), SECRET_FILE_MODE);
    profile.lastLoginAt = nowIso(); profile.authStatus = 'logged_in';
  }

  function publicProfile(profile, authStatus) {
    const statusValue = authStatus?.status || profile.authStatus || 'unknown';
    return { id: profile.id, name: profile.name, mode: profile.mode, home: homeFor(profile), active: profile.active === true, lastLoginAt: profile.lastLoginAt || '', lastBackupAt: profile.lastBackupAt || '', authStatus: statusValue, detail: statusValue === 'logged_in' ? 'Codex 已完成认证。' : authStatus?.detail || '', keyHint: profile.keyHint || '' };
  }

  async function list(state) {
    await ensureLayout();
    state.codexAuthProfiles ||= {};
    if (!state.codexAuthProfiles.default) state.codexAuthProfiles.default = { id: 'default', name: '当前 Codex', mode: 'apikey', active: true, authStatus: 'unknown' };
    const profiles = [];
    for (const profile of Object.values(state.codexAuthProfiles)) {
      const current = await status(profile);
      profile.authStatus = current.status;
      if (await readAuth(profile) && !profile.lastBackupAt) await encryptedBackup(profile, 'initial_discovery');
      profiles.push(publicProfile(profile, current));
    }
    return profiles;
  }

  function get(state, id) { return state.codexAuthProfiles?.[safeProfileId(id)]; }

  async function create(state, body = {}) {
    await ensureLayout(); state.codexAuthProfiles ||= {};
    const id = safeProfileId(body.id || cleanName(body.name, 'account').toLowerCase().replace(/[^a-z0-9_-]+/g, '-'));
    if (!id || id === 'default' || state.codexAuthProfiles[id]) throw Object.assign(new Error('profile_exists_or_invalid'), { code: 'profile_exists_or_invalid' });
    const profile = { id, name: cleanName(body.name, id), mode: body.mode === 'device' ? 'device' : 'apikey', active: false, authStatus: 'logged_out' };
    state.codexAuthProfiles[id] = profile; await ensureProfileHome(profile); return publicProfile(profile);
  }

  async function apiKeyLogin(state, profile, apiKey) {
    if (!apiKey || String(apiKey).length < 20) throw Object.assign(new Error('invalid_api_key'), { code: 'invalid_api_key' });
    await ensureLayout(); const before = await readAuth(profile); if (before) await encryptedBackup(profile, 'before_login');
    const result = await execLogin(profile, ['login', '--with-api-key'], `${String(apiKey).trim()}\n`);
    if (result.code !== 0) throw Object.assign(new Error('api_key_login_failed'), { code: 'api_key_login_failed', detail: sanitizeOutput(result.stderr || result.stdout) });
    profile.mode = 'apikey'; profile.keyHint = maskSecret(apiKey); profile.lastLoginAt = nowIso(); profile.authStatus = 'logged_in';
    await encryptedBackup(profile, 'login'); return publicProfile(profile, await status(profile));
  }

  async function startDevice(state, profile) {
    await ensureLayout(); const before = await readAuth(profile); if (before) await encryptedBackup(profile, 'before_device_login');
    const task = { id: randomUUID(), profileId: profile.id, status: 'starting', message: '', startedAt: nowIso(), finishedAt: '' }; tasks.set(task.id, task);
    const command = codexBin.endsWith('.js') ? codexNode : codexBin; const args = codexBin.endsWith('.js') ? [codexBin, 'login', '--device-auth'] : ['login', '--device-auth'];
    const child = spawn(command, args, { cwd: homeFor(profile), detached: process.platform !== 'win32', env: { ...commandEnv(), CODEX_HOME: homeFor(profile) }, stdio: ['ignore', 'pipe', 'pipe'] });
    task.status = 'waiting'; task.pid = child.pid || 0;
    const collect = (chunk) => { task.message = sanitizeOutput(`${task.message}\n${chunk.toString()}`).trim(); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', (error) => { task.status = 'failed'; task.message = sanitizeOutput(error.message); task.finishedAt = nowIso(); });
    child.on('close', async (code) => { const current = await status(profile); if (code === 0 && current.status === 'logged_in') { profile.mode = 'device'; profile.authStatus = 'logged_in'; profile.lastLoginAt = nowIso(); await encryptedBackup(profile, 'device_login'); task.status = 'completed'; } else { task.status = 'failed'; task.message = current.detail || task.message || `授权进程退出 ${code}`; } task.finishedAt = nowIso(); });
    return task;
  }

  async function logout(state, profile) { if (runningCount() > 0) throw Object.assign(new Error('codex_sessions_running'), { code: 'codex_sessions_running' }); await encryptedBackup(profile, 'before_logout'); await execLogin(profile, ['logout']); profile.authStatus = 'logged_out'; profile.lastLoginAt = ''; return publicProfile(profile); }
  async function activate(state, profile) { if (runningCount() > 0) throw Object.assign(new Error('codex_sessions_running'), { code: 'codex_sessions_running' }); for (const item of Object.values(state.codexAuthProfiles || {})) item.active = item.id === profile.id; return publicProfile(profile); }
  function task(id) { return tasks.get(id) || null; }
  function home(profile) { return homeFor(profile); }
  return { ensureLayout, list, get, create, apiKeyLogin, startDevice, logout, activate, task, listBackups, restore, home, publicProfile };
}
