import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, stat, rename, readdir, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 7072);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PASSWORD_FILE = path.join(DATA_DIR, 'admin-password.txt');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const CODEX_HOME = process.env.CODEX_HOME || '/root/.codex';
const CODEX_BIN = process.env.CODEX_BIN || '/root/.nvm/versions/node/v22.22.0/bin/codex';
const CODEX_NODE = process.env.CODEX_NODE || process.execPath;
const CODEX_BIN_DIR = path.dirname(CODEX_BIN);
const COOKIE_NAME = 'cmc_session';
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon'
};

let adminPassword = '';
let state = {
  version: 1,
  nextSeq: 1,
  authSessions: {},
  sessions: {}
};
const clients = new Map();
const running = new Map();

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function init() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(UPLOAD_DIR, { recursive: true });
  if (!(await exists(PASSWORD_FILE))) {
    const password = randomBytes(18).toString('base64url');
    await writeFile(PASSWORD_FILE, `${password}\n`, { mode: 0o600 });
  }
  adminPassword = (await readFile(PASSWORD_FILE, 'utf8')).trim();
  if (await exists(STATE_FILE)) {
    state = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    state.authSessions ||= {};
    state.sessions ||= {};
    state.hiddenCodexSessions ||= {};
    state.codexSessionTitles ||= {};
    state.starredMessages ||= {};
    state.nextSeq ||= 1;
  } else {
    state.hiddenCodexSessions ||= {};
    state.codexSessionTitles ||= {};
    state.starredMessages ||= {};
    await saveState();
  }
  reconcileRunningSessions();
  pruneAuthSessions();
}

function reconcileRunningSessions() {
  for (const session of Object.values(state.sessions || {})) {
    if (session.status === 'running' || session.status === 'stopping') {
      session.status = 'error';
      addMessage(session, {
        role: 'system',
        text: 'Service restarted while Codex was running. Send the prompt again to continue.',
        status: 'error'
      });
    }
  }
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveState().catch(console.error), 100);
}

async function saveState() {
  const tmp = `${STATE_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(tmp, STATE_FILE);
}

function nowIso() {
  return new Date().toISOString();
}

function json(res, code, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders
  });
  res.end(payload);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) reject(new Error('body_too_large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw) return {};
  return JSON.parse(raw);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (!key) continue;
    out[key] = decodeURIComponent(rest.join('='));
  }
  return out;
}

function cookieHeader(token, maxAgeSeconds) {
  const secure = process.env.COOKIE_SECURE === '0' ? '' : '; Secure';
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function pruneAuthSessions() {
  const now = Date.now();
  for (const [token, session] of Object.entries(state.authSessions)) {
    if (!session || session.expiresAt <= now) delete state.authSessions[token];
  }
}

function getAuth(req) {
  pruneAuthSessions();
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const session = state.authSessions[token];
  if (!session || session.expiresAt <= Date.now()) return null;
  session.lastSeenAt = Date.now();
  return { token, session };
}

function requireAuth(req, res) {
  const auth = getAuth(req);
  if (!auth) {
    json(res, 401, { error: 'unauthorized' });
    return null;
  }
  return auth;
}

function safeCompare(a, b) {
  const left = Buffer.from(createHash('sha256').update(String(a)).digest('hex'));
  const right = Buffer.from(createHash('sha256').update(String(b)).digest('hex'));
  return timingSafeEqual(left, right);
}

function publicSession(session) {
  return {
    id: session.id,
    source: session.source || 'web',
    title: session.title,
    cwd: session.cwd,
    model: session.model || '',
    sandbox: session.sandbox,
    approval: session.approval,
    codexSessionId: session.codexSessionId || '',
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastSeq: session.lastSeq || 0,
    queuedCount: session.queue?.length || 0,
    queue: (session.queue || []).map((item) => ({
      id: item.id,
      prompt: item.prompt,
      elevated: item.elevated === true,
      imageCount: item.images?.length || 0,
      images: (item.images || []).map((image) => ({
        name: image.name,
        type: image.type,
        url: image.url
      })),
      createdAt: item.createdAt
    })),
    messageCount: session.messages?.length || 0
  };
}

function publicExternalSession(session) {
  return {
    id: `codex:${session.codexSessionId}`,
    source: 'codex',
    title: state.codexSessionTitles?.[session.codexSessionId] || session.title,
    cwd: session.cwd,
    model: '',
    sandbox: '',
    approval: '',
    codexSessionId: session.codexSessionId,
    status: 'external',
    createdAt: session.createdAt || session.updatedAt,
    updatedAt: session.updatedAt,
    lastSeq: 0,
    messageCount: null
  };
}

function sortPublicSessions(sessions) {
  return sessions.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function textFromContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        return part?.text || part?.output_text || part?.input_text || '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return content.text || content.output_text || content.input_text || '';
}

function compactText(text, limit = 8000) {
  const value = String(text || '').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...[truncated]`;
}

const imageTypes = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp']
]);

function uploadUrl(fileName) {
  return `/api/uploads/${encodeURIComponent(fileName)}`;
}

async function savePromptImages(images) {
  if (!Array.isArray(images) || !images.length) return [];
  const saved = [];
  for (const image of images.slice(0, 4)) {
    const type = String(image.type || '').toLowerCase();
    const ext = imageTypes.get(type);
    if (!ext) throw new Error('unsupported_image_type');
    const value = String(image.data || '');
    const base64 = value.includes(',') ? value.split(',').pop() : value;
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length || buffer.length > 8 * 1024 * 1024) throw new Error('invalid_image_size');
    const fileName = `${randomUUID()}${ext}`;
    const filePath = path.join(UPLOAD_DIR, fileName);
    await writeFile(filePath, buffer, { mode: 0o600 });
    saved.push({
      name: String(image.name || fileName).slice(0, 120),
      type,
      fileName,
      path: filePath,
      url: uploadUrl(fileName)
    });
  }
  return saved;
}

function stableMessageId(...parts) {
  return createHash('sha1').update(parts.map((part) => String(part || '')).join('\0')).digest('hex').slice(0, 24);
}

function shouldSkipCodexText(role, text) {
  if (!text) return true;
  if (role === 'system' || role === 'developer') return true;
  if (text.includes('<permissions instructions>')) return true;
  if (text.includes('<skills_instructions>')) return true;
  if (text.includes('<environment_context>')) return true;
  if (text.includes('encrypted_content')) return true;
  return false;
}

function stripCodexImageTags(text) {
  return String(text || '')
    .replace(/<image\b[^>]*>\s*<\/image>/gi, '')
    .replace(/<image\b[^>]*\/>/gi, '')
    .trim();
}

async function readCodexThreadNames() {
  const indexFile = path.join(CODEX_HOME, 'session_index.jsonl');
  const names = new Map();
  try {
    const raw = await readFile(indexFile, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item.id) names.set(item.id, {
          title: item.thread_name || item.id,
          updatedAt: item.updated_at || ''
        });
      } catch {
        // Ignore corrupt historical index lines.
      }
    }
  } catch {
    // The index is optional; session files are the source of truth.
  }
  return names;
}

async function walkFiles(root, out = [], limit = 800) {
  if (out.length >= limit) return out;
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= limit) break;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) await walkFiles(full, out, limit);
    if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

async function readCodexSessionFile(file, names) {
  const info = await stat(file);
  const updatedAt = new Date(info.mtimeMs).toISOString();
  const raw = await readFile(file, 'utf8');
  for (const line of raw.split('\n').slice(0, 80)) {
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    if (item.type !== 'session_meta') continue;
    const payload = item.payload || {};
    const codexSessionId = payload.id;
    if (!codexSessionId) return null;
    const indexed = names.get(codexSessionId) || {};
    return {
      codexSessionId,
      title: indexed.title || payload.thread_name || path.basename(payload.cwd || file),
      cwd: payload.cwd || '',
      createdAt: payload.timestamp || item.timestamp || updatedAt,
      updatedAt: indexed.updatedAt || updatedAt,
      file
    };
  }
  return null;
}

async function findCodexSession(codexSessionId) {
  const names = await readCodexThreadNames();
  const files = await walkFiles(path.join(CODEX_HOME, 'sessions'));
  for (const file of files) {
    try {
      const session = await readCodexSessionFile(file, names);
      if (session?.codexSessionId === codexSessionId) return session;
    } catch {
      // Ignore malformed historical files.
    }
  }
  return null;
}

async function readCodexMessages(codexSessionId) {
  const session = await findCodexSession(codexSessionId);
  if (!session?.file) return [];

  const raw = await readFile(session.file, 'utf8');
  const messages = [];
  let seq = -1000000;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }

    const at = item.timestamp || session.updatedAt || nowIso();
    const payload = item.payload || {};
    let message = null;

    if (item.type === 'event_msg') {
      if (payload.type === 'user_message') {
        message = { role: 'user', text: payload.message || '' };
      } else if (payload.type === 'agent_message') {
        message = { role: 'assistant', text: payload.message || '', phase: payload.phase || '' };
      } else if (payload.type === 'exec_command_end') {
        const command = Array.isArray(payload.command) ? payload.command.join(' ') : payload.command || '';
        const output = payload.aggregated_output || payload.stdout || payload.stderr || '';
        const status = payload.status || (payload.exit_code === 0 ? 'completed' : 'failed');
        message = { role: 'tool', text: [`$ ${command}`, `[${status}]`, output].filter(Boolean).join('\n') };
      }
    } else if (item.type === 'response_item') {
      if (payload.type === 'function_call') {
        const args = typeof payload.arguments === 'string' ? payload.arguments : JSON.stringify(payload.arguments || {});
        message = { role: 'tool', text: `${payload.name || 'tool'} ${args}` };
      } else if (payload.type === 'function_call_output') {
        message = { role: 'tool', text: payload.output || '' };
      } else if (payload.type === 'message') {
        const role = payload.role || 'assistant';
        message = { role, text: textFromContent(payload.content) };
      }
    } else if (item.type === 'item.completed') {
      const completed = item.item || {};
      if (completed.type === 'agent_message') message = { role: 'assistant', text: completed.text || '' };
      if (completed.type === 'tool_call' || completed.type === 'function_call') {
        message = { role: 'tool', text: JSON.stringify(completed) };
      }
    }

    if (message) message.text = stripCodexImageTags(message.text);
    if (!message || shouldSkipCodexText(message.role, message.text)) continue;
    const text = compactText(message.text);
    const id = stableMessageId(codexSessionId, item.timestamp, item.type, message.role, text);
    messages.push({
      seq: seq++,
      id,
      at,
      source: 'codex',
      role: message.role,
      text,
      phase: message.phase || '',
      starred: state.starredMessages?.[id] === true
    });
  }

  return messages;
}

async function deleteCodexSessionFile(codexSessionId) {
  const session = await findCodexSession(codexSessionId);
  if (!session?.file) return false;
  const sessionsRoot = path.resolve(CODEX_HOME, 'sessions');
  const file = path.resolve(session.file);
  if (!file.startsWith(`${sessionsRoot}${path.sep}`)) throw new Error('invalid_codex_session_path');
  await unlink(file);
  return true;
}

async function displayMessages(session, limit = 500) {
  const codexMessages = session.codexSessionId ? await readCodexMessages(session.codexSessionId) : [];
  const out = [];
  const seen = new Map();
  for (const message of [...codexMessages, ...(session.messages || [])]) {
    const key = `${message.role}\0${String(message.text || '').trim()}`;
    const next = {
      ...message,
      starred: message.starred === true || state.starredMessages?.[message.id] === true
    };
    if (seen.has(key)) {
      const index = seen.get(key);
      const existing = out[index];
      const nextHasImages = next.images?.length;
      const existingHasImages = existing.images?.length;
      out[index] = {
        ...(nextHasImages && !existingHasImages ? next : existing),
        starred: existing.starred === true || next.starred === true,
        images: existingHasImages ? existing.images : next.images
      };
      continue;
    }
    seen.set(key, out.length);
    out.push(next);
  }
  const sorted = out.sort((a, b) => {
    const byTime = Date.parse(a.at || '') - Date.parse(b.at || '');
    return byTime || (a.seq || 0) - (b.seq || 0);
  });
  return limit > 0 ? sorted.slice(-limit) : sorted;
}

async function listCodexSessions() {
  const names = await readCodexThreadNames();
  const files = await walkFiles(path.join(CODEX_HOME, 'sessions'));
  const imported = new Set(Object.values(state.sessions || {}).map((session) => session.codexSessionId).filter(Boolean));
  const hidden = new Set(Object.keys(state.hiddenCodexSessions || {}));
  const byId = new Map();
  for (const file of files) {
    try {
      const session = await readCodexSessionFile(file, names);
      if (!session || imported.has(session.codexSessionId)) continue;
      if (hidden.has(session.codexSessionId)) continue;
      const existing = byId.get(session.codexSessionId);
      if (!existing || String(session.updatedAt) > String(existing.updatedAt)) {
        byId.set(session.codexSessionId, session);
      }
    } catch {
      // Keep the index usable if an old session file is malformed.
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map(publicExternalSession);
}

async function importCodexSession(codexSessionId) {
  const existing = Object.values(state.sessions || {}).find((session) => session.codexSessionId === codexSessionId);
  if (existing) return existing;

  const external = await findCodexSession(codexSessionId);
  if (!external) return null;
  delete state.hiddenCodexSessions?.[codexSessionId];

  const id = randomUUID();
  const now = nowIso();
  const history = await readCodexMessages(codexSessionId);
  state.sessions[id] = {
    id,
    source: 'web',
    title: state.codexSessionTitles?.[codexSessionId] || external.title || `Codex ${codexSessionId.slice(0, 8)}`,
    cwd: external.cwd || '/root/Projects',
    model: '',
    sandbox: 'workspace-write',
    approval: 'on-request',
    codexSessionId,
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    lastSeq: 0,
    messages: history
  };
  addMessage(state.sessions[id], {
    role: 'system',
    text: `Imported Codex thread ${codexSessionId}. Loaded ${history.length} saved messages.`
  });
  return state.sessions[id];
}

async function listDirectories(dir) {
  const current = path.resolve(dir || '/root/Projects');
  const entries = [];
  const items = await readdir(current, { withFileTypes: true });
  for (const item of items) {
    if (!item.isDirectory()) continue;
    if (item.name === 'node_modules' || item.name === '.git') continue;
    const full = path.join(current, item.name);
    entries.push({ name: item.name, path: full });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return {
    path: current,
    parent: path.dirname(current) === current ? '' : path.dirname(current),
    entries
  };
}

function addMessage(session, message) {
  const entry = {
    seq: state.nextSeq++,
    id: randomUUID(),
    at: nowIso(),
    ...message
  };
  session.messages.push(entry);
  session.lastSeq = entry.seq;
  session.updatedAt = entry.at;
  scheduleSave();
  broadcast(session.id, entry);
  return entry;
}

function broadcast(sessionId, message) {
  const set = clients.get(sessionId);
  if (!set) return;
  const line = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
  for (const res of set) res.write(line);
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function buildCodexArgs(session, prompt, options = {}) {
  if (session.codexSessionId) {
    const args = ['exec', 'resume', '--json', '--skip-git-repo-check'];
    if (session.model) args.push('-m', session.model);
    if (options.elevated) args.push('--dangerously-bypass-approvals-and-sandbox');
    for (const imagePath of options.imagePaths || []) args.push('--image', imagePath);
    args.push(session.codexSessionId, '-');
    return args;
  }

  const args = ['exec', '--json', '-C', session.cwd, '--skip-git-repo-check'];
  if (session.model) args.push('-m', session.model);
  if (options.elevated) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else if (session.sandbox) {
    args.push('-s', session.sandbox);
  }
  for (const imagePath of options.imagePaths || []) args.push('--image', imagePath);
  args.push('-');
  return args;
}

function deriveMessageFromCodexEvent(event) {
  if (event?.type === 'thread.started' && event.thread_id) {
    return { role: 'system', text: `Codex thread ${event.thread_id} started.`, rawType: event.type };
  }

  if (event?.type === 'turn.started') {
    return null;
  }

  if (event?.type === 'turn.completed') {
    return null;
  }

  if (event?.type === 'item.completed') {
    const item = event.item || {};
    if (item.type === 'agent_message' && item.text) {
      return { role: 'assistant', text: item.text, rawType: event.type };
    }
    if (item.type === 'tool_call' || item.type === 'function_call') {
      return { role: 'tool', text: JSON.stringify(item).slice(0, 3000), rawType: event.type };
    }
  }

  if (event?.type === 'event_msg') {
    const payload = event.payload || {};
    if (payload.type === 'agent_message' && payload.message) {
      return {
        role: 'assistant',
        phase: payload.phase || 'message',
        text: payload.message,
        rawType: payload.type
      };
    }
    if (payload.type === 'task_started') {
      return { role: 'system', text: 'Codex run started.', rawType: payload.type };
    }
    if (payload.type === 'exec_command_end') {
      const command = Array.isArray(payload.command) ? payload.command.join(' ') : '';
      const output = String(payload.aggregated_output || payload.stdout || '').trim();
      const status = payload.status || (payload.exit_code === 0 ? 'completed' : 'failed');
      return {
        role: 'tool',
        text: [`$ ${command}`, `[${status}]`, output.slice(0, 3000)].filter(Boolean).join('\n'),
        rawType: payload.type
      };
    }
  }

  if (event?.type === 'response_item') {
    const payload = event.payload || {};
    if (payload.type === 'function_call') {
      const name = payload.name || 'tool';
      let args = payload.arguments || '';
      if (typeof args !== 'string') args = JSON.stringify(args);
      return { role: 'tool', text: `${name} ${args}`.slice(0, 1200), rawType: payload.type };
    }
    if (payload.type === 'message' && payload.role === 'assistant') {
      const text = (payload.content || [])
        .map((part) => part.text || part.output_text || '')
        .filter(Boolean)
        .join('\n');
      if (text) return { role: 'assistant', text, rawType: payload.type };
    }
  }

  return null;
}

function updateCodexSessionId(session, event) {
  if (event?.type === 'thread.started' && event.thread_id) {
    session.codexSessionId = event.thread_id;
    return;
  }

  const id = event?.payload?.id || event?.payload?.session_id || event?.payload?.payload?.id;
  if (event?.type === 'session_meta' && event?.payload?.id) session.codexSessionId = event.payload.id;
  if (event?.type === 'event_msg' && event?.payload?.type === 'session_meta' && id) session.codexSessionId = id;
  if (event?.type === 'response_item' && event?.payload?.type === 'session_meta' && id) session.codexSessionId = id;
  if (event?.type === 'session_meta' && id) session.codexSessionId = id;
}

function runCodex(session, prompt, options = {}) {
  if (running.has(session.id)) throw new Error('session_running');

  session.queue ||= [];
  session.status = 'running';
  session.updatedAt = nowIso();
  scheduleSave();
  addMessage(session, {
    role: 'system',
    text: options.elevated ? 'Codex is working with elevated permissions for this run.' : 'Codex is working.',
    status: 'running',
    queuedCount: session.queue?.length || 0
  });

  const args = buildCodexArgs(session, prompt, options);
  const command = CODEX_BIN.endsWith('.js') ? CODEX_NODE : CODEX_BIN;
  const commandArgs = CODEX_BIN.endsWith('.js') ? [CODEX_BIN, ...args] : args;
  const child = spawn(command, commandArgs, {
    cwd: session.cwd,
    detached: true,
    env: {
      ...process.env,
      PATH: `${CODEX_BIN_DIR}:${process.env.PATH || ''}`,
      NO_COLOR: '1'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  running.set(session.id, child);

  child.stdin.write(prompt);
  child.stdin.end();

  let stdoutBuffer = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) handleCodexLine(session, line);
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8').trim();
    if (text) addMessage(session, { role: 'tool', text, rawType: 'stderr' });
  });

  child.on('error', (error) => {
    running.delete(session.id);
    session.status = 'error';
    addMessage(session, {
      role: 'system',
      text: `Failed to start Codex: ${error.message}`,
      status: 'error'
    });
    scheduleSave();
  });

  child.on('close', (code) => {
    if (!running.has(session.id) && session.status === 'error') return;
    if (stdoutBuffer.trim()) handleCodexLine(session, stdoutBuffer);
    running.delete(session.id);
    const wasStopping = session.status === 'stopping';
    addMessage(session, {
      role: 'system',
      text: wasStopping ? 'Codex run stopped.' : code === 0 ? 'Codex run finished.' : `Codex exited with code ${code}.`,
      status: code === 0 || wasStopping ? 'idle' : 'error',
      queuedCount: session.queue?.length || 0
    });

    const next = !wasStopping ? session.queue?.shift() : null;
    if (next?.prompt) {
      scheduleSave();
      runCodex(session, next.prompt, { elevated: next.elevated, imagePaths: (next.images || []).map((image) => image.path) });
      return;
    }

    session.status = code === 0 || wasStopping ? 'idle' : 'error';
    session.updatedAt = nowIso();
    scheduleSave();
  });
}

function stopRunningSession(session) {
  const child = running.get(session.id);
  if (!child) return false;

  session.status = 'stopping';
  session.updatedAt = nowIso();
  const queuedCount = session.queue?.length || 0;
  if (queuedCount) session.queue = [];
  addMessage(session, {
    role: 'system',
    text: queuedCount ? `Stop requested. Cleared ${queuedCount} queued prompt${queuedCount === 1 ? '' : 's'}.` : 'Stop requested.',
    status: 'stopping',
    queuedCount: 0
  });

  try {
    if (child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // The close handler will reconcile status if the process is already gone.
    }
  }

  setTimeout(() => {
    if (!running.has(session.id)) return;
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // Best effort; the running map is cleaned up by close/error handlers.
      }
    }
  }, 3000).unref();

  scheduleSave();
  return true;
}

function handleCodexLine(session, line) {
  const text = line.trim();
  if (!text) return;
  let event = null;
  try {
    event = JSON.parse(text);
  } catch {
    addMessage(session, { role: 'tool', text, rawType: 'stdout' });
    return;
  }

  updateCodexSessionId(session, event);
  const message = deriveMessageFromCodexEvent(event);
  if (message) addMessage(session, message);
}

async function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? '/index.html' : pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(PUBLIC_DIR, file);
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    await stat(fullPath);
    const ext = path.extname(fullPath);
    res.writeHead(200, {
      'content-type': contentTypes[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=3600'
    });
    createReadStream(fullPath).pipe(res);
  } catch {
    if (!pathname.startsWith('/api/') && !pathname.startsWith('/events')) {
      const index = path.join(PUBLIC_DIR, 'index.html');
      res.writeHead(200, { 'content-type': contentTypes['.html'], 'cache-control': 'no-store' });
      createReadStream(index).pipe(res);
      return;
    }
    json(res, 404, { error: 'not_found' });
  }
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/healthz') return json(res, 200, { ok: true });

  if (url.pathname === '/api/login' && req.method === 'POST') {
    const body = await readJson(req);
    if (!safeCompare(body.password || '', adminPassword)) {
      return json(res, 401, { error: 'bad_password' });
    }
    const token = randomBytes(32).toString('base64url');
    state.authSessions[token] = {
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      expiresAt: Date.now() + THIRTY_DAYS
    };
    scheduleSave();
    return json(res, 200, { ok: true, expiresAt: state.authSessions[token].expiresAt }, {
      'set-cookie': cookieHeader(token, THIRTY_DAYS / 1000)
    });
  }

  if (url.pathname === '/api/logout' && req.method === 'POST') {
    const token = parseCookies(req)[COOKIE_NAME];
    if (token) delete state.authSessions[token];
    scheduleSave();
    return json(res, 200, { ok: true }, { 'set-cookie': cookieHeader('', 0) });
  }

  const auth = requireAuth(req, res);
  if (!auth) return;

  if (url.pathname === '/api/me') {
    return json(res, 200, { ok: true, expiresAt: auth.session.expiresAt });
  }

  const uploadMatch = url.pathname.match(/^\/api\/uploads\/([^/]+)$/);
  if (uploadMatch && req.method === 'GET') {
    const fileName = decodeURIComponent(uploadMatch[1]);
    if (!/^[a-f0-9-]+\.(png|jpg|webp)$/.test(fileName)) return json(res, 400, { error: 'invalid_upload_name' });
    const filePath = path.join(UPLOAD_DIR, fileName);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(`${path.resolve(UPLOAD_DIR)}${path.sep}`)) return json(res, 403, { error: 'forbidden' });
    try {
      await stat(resolved);
      const ext = path.extname(resolved);
      const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'private, max-age=3600' });
      createReadStream(resolved).pipe(res);
    } catch {
      json(res, 404, { error: 'upload_not_found' });
    }
    return;
  }

  if (url.pathname === '/api/projects') {
    const projectsRoot = process.env.PROJECTS_ROOT || '/root/Projects';
    return json(res, 200, {
      roots: [projectsRoot, '/root/data/disk/Projects'],
      defaultCwd: projectsRoot
    });
  }

  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    const webSessions = Object.values(state.sessions).map(publicSession);
    const codexSessions = await listCodexSessions();
    const sessions = sortPublicSessions([...webSessions, ...codexSessions]);
    return json(res, 200, { sessions });
  }

  if (url.pathname === '/api/codex-sessions/import' && req.method === 'POST') {
    const body = await readJson(req);
    const codexSessionId = String(body.codexSessionId || '').trim();
    if (!codexSessionId) return json(res, 400, { error: 'missing_codex_session_id' });
    const session = await importCodexSession(codexSessionId);
    if (!session) return json(res, 404, { error: 'codex_session_not_found' });
    scheduleSave();
    return json(res, 201, { session: publicSession(session) });
  }

  if (url.pathname === '/api/fs' && req.method === 'GET') {
    const dir = url.searchParams.get('path') || '/root/Projects';
    try {
      return json(res, 200, await listDirectories(dir));
    } catch (error) {
      return json(res, 400, { error: 'cannot_read_directory', message: String(error.message || error) });
    }
  }

  if (url.pathname === '/api/sessions' && req.method === 'POST') {
    const body = await readJson(req);
    const id = randomUUID();
    const cwd = path.resolve(body.cwd || '/root/Projects');
    const title = String(body.title || path.basename(cwd) || 'Codex session').slice(0, 80);
    state.sessions[id] = {
      id,
      title,
      cwd,
      model: String(body.model || ''),
      sandbox: body.sandbox || 'workspace-write',
      approval: body.approval || 'on-request',
      codexSessionId: '',
      status: 'idle',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastSeq: 0,
      messages: []
    };
    addMessage(state.sessions[id], { role: 'system', text: `Session created in ${cwd}.` });
    return json(res, 201, { session: publicSession(state.sessions[id]) });
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch && req.method === 'PATCH') {
    const sessionId = decodeURIComponent(sessionMatch[1]);
    const body = await readJson(req);
    const title = String(body.title || '').trim().slice(0, 80);
    if (!title) return json(res, 400, { error: 'empty_title' });

    if (sessionId.startsWith('codex:')) {
      const codexSessionId = sessionId.slice('codex:'.length);
      state.codexSessionTitles ||= {};
      state.codexSessionTitles[codexSessionId] = title;
      for (const session of Object.values(state.sessions || {})) {
        if (session.codexSessionId === codexSessionId) {
          session.title = title;
          session.updatedAt = nowIso();
        }
      }
      scheduleSave();
      const external = await findCodexSession(codexSessionId);
      return json(res, 200, {
        session: publicExternalSession(external || { codexSessionId, title, cwd: '', updatedAt: nowIso(), createdAt: nowIso() })
      });
    }

    const session = state.sessions[sessionId];
    if (!session) return json(res, 404, { error: 'session_not_found' });
    session.title = title;
    session.updatedAt = nowIso();
    scheduleSave();
    return json(res, 200, { session: publicSession(session) });
  }

  if (sessionMatch && req.method === 'GET') {
    const sessionId = decodeURIComponent(sessionMatch[1]);
    const session = state.sessions[sessionId];
    if (!session) return json(res, 404, { error: 'session_not_found' });
    const rawLimit = Number(url.searchParams.get('limit') ?? 500);
    const limit = Number.isFinite(rawLimit) ? Math.max(0, Math.min(5000, Math.floor(rawLimit))) : 500;
    return json(res, 200, { session: publicSession(session), messages: await displayMessages(session, limit), limit });
  }

  if (sessionMatch && req.method === 'DELETE') {
    const sessionId = decodeURIComponent(sessionMatch[1]);
    const body = await readJson(req);
    if (sessionId.startsWith('codex:')) {
      const codexSessionId = sessionId.slice('codex:'.length);
      const deletedCodex = await deleteCodexSessionFile(codexSessionId);
      state.hiddenCodexSessions ||= {};
      state.hiddenCodexSessions[codexSessionId] = nowIso();
      if (state.codexSessionTitles) delete state.codexSessionTitles[codexSessionId];
      scheduleSave();
      return json(res, 200, { ok: true, hidden: true, deletedCodex });
    }

    const session = state.sessions[sessionId];
    if (!session) return json(res, 404, { error: 'session_not_found' });
    if (running.has(sessionId)) return json(res, 409, { error: 'session_running' });
    let deletedCodex = false;
    if (body.deleteCodex === true && session.codexSessionId) {
      deletedCodex = await deleteCodexSessionFile(session.codexSessionId);
      if (state.codexSessionTitles) delete state.codexSessionTitles[session.codexSessionId];
    }
    delete state.sessions[sessionId];
    scheduleSave();
    return json(res, 200, { ok: true, deletedCodex });
  }

  const sendMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (sendMatch && req.method === 'POST') {
    const session = state.sessions[decodeURIComponent(sendMatch[1])];
    if (!session) return json(res, 404, { error: 'session_not_found' });
    const body = await readJson(req, 32 * 1024 * 1024);
    const prompt = String(body.prompt || '').trim();
    const elevated = body.elevated === true;
    const clientMessageId = String(body.clientMessageId || '').trim().slice(0, 120);
    const queueId = clientMessageId || randomUUID();
    const images = await savePromptImages(body.images || []);
    if (!prompt && !images.length) return json(res, 400, { error: 'empty_prompt' });
    const effectivePrompt = prompt || '请分析这张图片。';
    addMessage(session, { role: 'user', text: effectivePrompt, elevated, clientMessageId, images });
    if (running.has(session.id)) {
      session.queue ||= [];
      session.queue.push({ id: queueId, prompt: effectivePrompt, elevated, images, createdAt: nowIso(), clientMessageId });
      session.updatedAt = nowIso();
      scheduleSave();
      return json(res, 202, { session: publicSession(session), queued: true });
    }
    try {
      runCodex(session, effectivePrompt, { elevated, imagePaths: images.map((image) => image.path) });
    } catch (error) {
      session.status = 'error';
      addMessage(session, { role: 'system', text: String(error.message || error), status: 'error' });
    }
    return json(res, 202, { session: publicSession(session) });
  }

  const queueMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/queue\/([^/]+)$/);
  if (queueMatch && req.method === 'DELETE') {
    const session = state.sessions[decodeURIComponent(queueMatch[1])];
    if (!session) return json(res, 404, { error: 'session_not_found' });
    const queueId = decodeURIComponent(queueMatch[2]);
    const index = (session.queue || []).findIndex((item) => item.id === queueId || item.clientMessageId === queueId);
    if (index < 0) return json(res, 404, { error: 'queue_item_not_found', session: publicSession(session) });
    session.queue.splice(index, 1);
    session.updatedAt = nowIso();
    scheduleSave();
    return json(res, 200, { ok: true, session: publicSession(session) });
  }

  const messagePatchMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages\/([^/]+)$/);
  if (messagePatchMatch && req.method === 'PATCH') {
    const session = state.sessions[decodeURIComponent(messagePatchMatch[1])];
    if (!session) return json(res, 404, { error: 'session_not_found' });
    const messageId = decodeURIComponent(messagePatchMatch[2]);
    const body = await readJson(req);
    const starred = body.starred === true;
    const message = (session.messages || []).find((item) => item.id === messageId || String(item.seq) === messageId);
    if (message) message.starred = starred;
    state.starredMessages ||= {};
    if (starred) state.starredMessages[messageId] = true;
    else delete state.starredMessages[messageId];
    session.updatedAt = nowIso();
    scheduleSave();
    return json(res, 200, { ok: true, messageId, starred, session: publicSession(session) });
  }

  const stopMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/stop$/);
  if (stopMatch && req.method === 'POST') {
    const session = state.sessions[decodeURIComponent(stopMatch[1])];
    if (!session) return json(res, 404, { error: 'session_not_found' });
    const stopped = stopRunningSession(session);
    return json(res, 200, { ok: true, stopped, session: publicSession(session) });
  }

  json(res, 404, { error: 'not_found' });
}

function handleEvents(req, res, url) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const sessionId = url.searchParams.get('sessionId');
  const session = state.sessions[sessionId];
  if (!session) return json(res, 404, { error: 'session_not_found' });

  const after = Number(url.searchParams.get('after') || 0);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'connection': 'keep-alive'
  });
  sendSse(res, 'hello', { sessionId, status: session.status, now: nowIso() });
  for (const message of session.messages || []) {
    if (message.seq > after) sendSse(res, 'message', message);
  }

  let set = clients.get(sessionId);
  if (!set) {
    set = new Set();
    clients.set(sessionId, set);
  }
  set.add(res);
  const ping = setInterval(() => sendSse(res, 'ping', { now: nowIso() }), 25000);
  req.on('close', () => {
    clearInterval(ping);
    set.delete(res);
    if (set.size === 0) clients.delete(sessionId);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type'
    });
    res.end();
    return;
  }

  if (url.pathname === '/api/events') return handleEvents(req, res, url);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((error) => json(res, 500, { error: 'internal', message: String(error.message || error) }));
    return;
  }

  serveStatic(req, res, url.pathname).catch((error) => json(res, 500, { error: 'internal', message: String(error.message || error) }));
});

await init();
server.listen(PORT, HOST, () => {
  console.log(`codex-mobile-console listening on http://${HOST}:${PORT}`);
});
