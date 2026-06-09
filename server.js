import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFile, copyFile, mkdir, readFile, writeFile, stat, rename, readdir, unlink, statfs, readlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 7072);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const RESTART_MARKER_FILE = path.join(DATA_DIR, 'restart-marker.json');
const PASSWORD_FILE = path.join(DATA_DIR, 'admin-password.txt');
const SKILL_REGISTRY_FILE = path.join(DATA_DIR, 'skill-registry.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const CODEX_HOME = process.env.CODEX_HOME || '/root/.codex';
const SKILL_ROOTS = (process.env.SKILL_ROOTS || `${path.join(CODEX_HOME, 'skills')},/root/.agents/skills`)
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const CODEX_BIN = process.env.CODEX_BIN || '/usr/bin/codex';
const CODEX_NODE = process.env.CODEX_NODE || process.execPath;
const CODEX_BIN_DIR = path.dirname(CODEX_BIN);
const COOKIE_NAME = 'cmc_session';
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
const RUNTIME_DIR = path.join(__dirname, 'runtime');
const SERVICE_STARTED_AT = new Date().toISOString();
const DEFAULT_STORAGE_SETTINGS = {
  autoCleanup: false,
  uploadRetentionDays: 30,
  runtimeRetentionDays: 7,
  maxUploadMb: 1024
};

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
const codexUsageCache = new Map();
const codexMessagesCache = new Map();
const clockTick = Number(process.env.CLK_TCK || 100);
let totalRequests = 0;
let activeRequests = 0;
let packageMetaCache = null;
let skillRegistry = {
  version: 1,
  roots: SKILL_ROOTS,
  skills: [],
  lastScanAt: '',
  scanStatus: 'idle',
  scanError: ''
};
let skillScanPromise = null;
let skillMaintenanceTimer = null;
let skillRegistryFileMtimeMs = 0;

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
  await loadSkillRegistry();
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
    state.storageSettings = normalizeStorageSettings(state.storageSettings);
    state.nextSeq ||= 1;
  } else {
    state.hiddenCodexSessions ||= {};
    state.codexSessionTitles ||= {};
    state.starredMessages ||= {};
    state.storageSettings = normalizeStorageSettings(state.storageSettings);
    await saveState();
  }
  const restartMarker = await consumeRestartMarker();
  reconcileRunningSessions(restartMarker);
  pruneAuthSessions();
  startStorageMaintenance();
  startRunMonitor();
  startSkillMaintenance();
}

function normalizeStorageSettings(value = {}) {
  return {
    autoCleanup: value.autoCleanup === true,
    uploadRetentionDays: clampInteger(value.uploadRetentionDays, 0, 3650, DEFAULT_STORAGE_SETTINGS.uploadRetentionDays),
    runtimeRetentionDays: clampInteger(value.runtimeRetentionDays, 0, 3650, DEFAULT_STORAGE_SETTINGS.runtimeRetentionDays),
    maxUploadMb: clampInteger(value.maxUploadMb, 0, 102400, DEFAULT_STORAGE_SETTINGS.maxUploadMb)
  };
}

function clampInteger(value, min, max, fallback) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(next)));
}

async function writeRestartMarker(reason = 'manual') {
  const marker = {
    version: 1,
    reason,
    requestedAt: nowIso(),
    pid: process.pid,
    running: [...running.keys()]
  };
  const tmp = `${RESTART_MARKER_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(marker, null, 2), { mode: 0o600 });
  await rename(tmp, RESTART_MARKER_FILE);
  return marker;
}

async function consumeRestartMarker() {
  try {
    const marker = JSON.parse(await readFile(RESTART_MARKER_FILE, 'utf8'));
    await unlink(RESTART_MARKER_FILE).catch(() => {});
    return marker;
  } catch {
    return null;
  }
}

function summarizeRunPrompt(activeRun) {
  const prompt = String(activeRun?.prompt || '').replace(/\s+/g, ' ').trim();
  if (!prompt) return '';
  return prompt.length > 180 ? `${prompt.slice(0, 180)}...` : prompt;
}

function reconcileRunningSessions(restartMarker = null) {
  const planned = Boolean(restartMarker);
  for (const session of Object.values(state.sessions || {})) {
    session.messages ||= [];
    session.queue ||= [];
    if (session.status === 'running' || session.status === 'stopping') {
      const activeRun = session.activeRun;
      const promptSummary = summarizeRunPrompt(activeRun);
      session.status = planned ? 'idle' : 'error';
      if (activeRun?.messageId) {
        updateMessageRunState(session, activeRun.messageId, planned ? 'recovered' : 'failed', {
          delivery: planned ? 'recovered' : 'failed'
        });
      }
      delete session.activeRun;
      addMessage(session, {
        role: 'system',
        text: [
          planned
            ? 'Service restarted with a recovery marker. The session was restored to an operable state.'
            : 'Service restarted unexpectedly while Codex was running. The session status was reconciled.',
          promptSummary ? `Interrupted prompt: ${promptSummary}` : '',
          'The interrupted prompt was not replayed automatically to avoid repeating file changes or commands.'
        ].filter(Boolean).join('\n'),
        status: session.status,
        queuedCount: session.queue.length
      });
    }
  }
}

function updateMessageRunState(session, messageId, runState, extra = {}) {
  if (!messageId) return null;
  const message = (session.messages || []).find((item) => item.id === messageId || item.clientMessageId === messageId);
  if (!message) return null;
  message.runState = runState;
  message.completedAt = ['completed', 'failed', 'stopped', 'recovered'].includes(runState) ? nowIso() : message.completedAt;
  Object.assign(message, extra);
  scheduleSave();
  broadcastEvent(session.id, 'message_update', message);
  return message;
}

function incompleteRunMessages(session) {
  return (session.messages || []).filter((message) => (
    message.role === 'user'
    && ['submitted', 'running', 'queued', 'stopping'].includes(message.runState)
  ));
}

function recoverStaleSession(session, reason = 'monitor') {
  session.messages ||= [];
  session.queue ||= [];
  const activeMessageId = session.activeRun?.messageId;
  for (const message of incompleteRunMessages(session)) {
    const isQueued = session.queue.some((item) => item.clientMessageId === message.clientMessageId || item.messageId === message.id);
    if (isQueued) continue;
    updateMessageRunState(session, message.id, 'recovered', { delivery: 'recovered' });
  }
  delete session.activeRun;
  session.status = 'idle';
  session.updatedAt = nowIso();
  addMessage(session, {
    role: 'system',
    text: `Recovered stale run state (${reason}). No Codex process was active for this session.`,
    status: 'idle',
    queuedCount: session.queue.length,
    recoveredMessageId: activeMessageId || ''
  });
}

function reconcileSessionRunState(session, reason = 'snapshot') {
  if (!session || session.source === 'codex') return false;
  session.messages ||= [];
  session.queue ||= [];
  const hasChild = running.has(session.id);
  const hasQueue = session.queue.length > 0;
  const staleStatus = ['running', 'stopping'].includes(session.status) && !hasChild;
  const staleMessages = incompleteRunMessages(session).some((message) => {
    if (message.runState === 'queued') return !hasQueue;
    return !hasChild;
  });
  if (!staleStatus && !staleMessages) return false;
  recoverStaleSession(session, reason);
  return true;
}

let saveTimer = null;
let restartRequested = false;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveState().catch(console.error), 100);
}

async function saveState() {
  const tmp = `${STATE_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(tmp, STATE_FILE);
}

async function prepareForShutdown(reason = 'signal') {
  if (running.size > 0) await writeRestartMarker(reason);
  await saveState();
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
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      if (error) reject(error);
      else resolve(value);
    };
    req.on('data', (chunk) => {
      if (done) return;
      body += chunk;
      if (body.length > limit) {
        finish(new Error('body_too_large'));
        req.destroy();
      }
    });
    req.on('end', () => finish(null, body));
    req.on('error', (error) => finish(error));
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
  session.messages ||= [];
  session.queue ||= [];
  const runtimeRunning = running.has(session.id);
  const isStopping = runtimeRunning && session.status === 'stopping';
  const effectiveStatus = runtimeRunning
    ? isStopping ? 'stopping' : 'running'
    : ['running', 'stopping'].includes(session.status) ? 'idle' : session.status;
  return {
    id: session.id,
    source: session.source || 'web',
    title: session.title,
    cwd: session.cwd,
    model: session.model || '',
    sandbox: session.sandbox,
    approval: session.approval,
    codexSessionId: session.codexSessionId || '',
    status: effectiveStatus,
    storedStatus: session.status,
    isRunning: runtimeRunning,
    canStop: runtimeRunning && !isStopping,
    trashedAt: session.trashedAt || '',
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastSeq: session.lastSeq || 0,
    queuedCount: session.queue.length,
    queue: session.queue.map((item) => ({
      id: item.id,
      prompt: item.prompt,
      displayPrompt: item.displayPrompt || item.prompt,
      elevated: item.elevated === true,
      imageCount: item.images?.length || 0,
      images: (item.images || []).map((image) => ({
        name: image.name,
        type: image.type,
        url: image.url
      })),
      createdAt: item.createdAt
    })),
    messageCount: session.messages.length
  };
}

function parseProcStat(raw) {
  const end = raw.lastIndexOf(')');
  if (end < 0) return null;
  const pid = Number(raw.slice(0, raw.indexOf(' ')));
  const comm = raw.slice(raw.indexOf('(') + 1, end);
  const rest = raw.slice(end + 2).trim().split(/\s+/);
  return {
    pid,
    comm,
    state: rest[0],
    ppid: Number(rest[1]),
    pgrp: Number(rest[2]),
    session: Number(rest[3]),
    ttyNr: Number(rest[4]),
    utime: Number(rest[11]),
    stime: Number(rest[12]),
    starttime: Number(rest[19]),
    rssPages: Number(rest[21])
  };
}

async function readProcessInfo(pid) {
  try {
    const [statRaw, statusRaw, cmdlineRaw] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readFile(`/proc/${pid}/status`, 'utf8').catch(() => ''),
      readFile(`/proc/${pid}/cmdline`).catch(() => Buffer.alloc(0))
    ]);
    const parsed = parseProcStat(statRaw);
    if (!parsed) return null;
    const status = Object.fromEntries(statusRaw.split('\n').map((line) => {
      const index = line.indexOf(':');
      return index > 0 ? [line.slice(0, index), line.slice(index + 1).trim()] : null;
    }).filter(Boolean));
    const cmdline = cmdlineRaw.toString('utf8').split('\0').filter(Boolean);
    let cwd = '';
    try {
      cwd = await readlink(`/proc/${pid}/cwd`);
    } catch {
      cwd = '';
    }
    const cpuMs = Math.round(((parsed.utime + parsed.stime) / clockTick) * 1000);
    return {
      pid,
      ppid: parsed.ppid,
      pgrp: parsed.pgrp,
      state: parsed.state,
      name: status.Name || parsed.comm,
      cmdline,
      cwd,
      threads: Number(status.Threads || 0),
      memoryKb: Number(String(status.VmRSS || '').match(/\d+/)?.[0] || 0),
      cpuMs
    };
  } catch {
    return null;
  }
}

async function processChildrenMap() {
  const entries = await readdir('/proc', { withFileTypes: true });
  const map = new Map();
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map(async (entry) => {
      try {
        const raw = await readFile(`/proc/${entry.name}/stat`, 'utf8');
        const parsed = parseProcStat(raw);
        if (!parsed) return;
        if (!map.has(parsed.ppid)) map.set(parsed.ppid, []);
        map.get(parsed.ppid).push(parsed.pid);
      } catch {
        // Process disappeared while scanning.
      }
    }));
  return map;
}

async function processTree(rootPid) {
  if (!rootPid) return [];
  const children = await processChildrenMap();
  const seen = new Set();
  const ordered = [];
  const visit = (pid, depth) => {
    if (!pid || seen.has(pid)) return;
    seen.add(pid);
    ordered.push({ pid, depth });
    for (const childPid of children.get(pid) || []) visit(childPid, depth + 1);
  };
  visit(rootPid, 0);
  const infos = await Promise.all(ordered.map(async (item) => ({
    ...item,
    ...(await readProcessInfo(item.pid))
  })));
  return infos.filter((item) => item.name);
}

function normalizeUsage(value = {}) {
  return {
    inputTokens: Number(value.input_tokens || 0),
    cachedInputTokens: Number(value.cached_input_tokens || 0),
    outputTokens: Number(value.output_tokens || 0),
    reasoningOutputTokens: Number(value.reasoning_output_tokens || 0),
    totalTokens: Number(value.total_tokens || 0)
  };
}

function parseCodexUsageLine(item, current = {}) {
  const payload = item.payload || {};
  if (item.type === 'turn_context') {
    return {
      ...current,
      model: payload.model || current.model || '',
      effort: payload.effort || current.effort || '',
      summary: payload.summary || current.summary || ''
    };
  }
  if (payload.type === 'task_started') {
    return {
      ...current,
      modelContextWindow: Number(payload.model_context_window || current.modelContextWindow || 0)
    };
  }
  if (payload.type !== 'token_count') return current;

  const info = payload.info || {};
  const modelContextWindow = Number(info.model_context_window || current.modelContextWindow || 0);
  const last = normalizeUsage(info.last_token_usage);
  const total = normalizeUsage(info.total_token_usage);
  const contextTokens = last.inputTokens || 0;
  const contextRemaining = modelContextWindow ? Math.max(0, modelContextWindow - contextTokens) : 0;
  const contextPercent = modelContextWindow ? Math.min(100, Math.round((contextTokens / modelContextWindow) * 1000) / 10) : 0;
  return {
    ...current,
    available: true,
    updatedAt: item.timestamp || current.updatedAt || '',
    modelContextWindow,
    contextTokens,
    contextRemaining,
    contextPercent,
    lastTokenUsage: last,
    totalTokenUsage: total,
    compactEstimate: {
      thresholdKnown: false,
      remainingTokens: contextRemaining,
      note: 'Codex exposes context window and current request tokens, but not the exact auto-compact threshold.'
    },
    rateLimits: payload.rate_limits || current.rateLimits || null
  };
}

async function codexUsageInfo(codexSessionId) {
  if (!codexSessionId) return null;
  const codexSession = await findCodexSession(codexSessionId);
  if (!codexSession?.file) return null;
  let info;
  try {
    info = await stat(codexSession.file);
  } catch {
    return null;
  }
  const cached = codexUsageCache.get(codexSession.file);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.value;

  const raw = await readFile(codexSession.file, 'utf8');
  let value = {
    available: false,
    codexSessionId,
    sessionFile: codexSession.file,
    fileBytes: info.size,
    fileUpdatedAt: new Date(info.mtimeMs).toISOString(),
    model: '',
    effort: '',
    summary: '',
    modelContextWindow: 0,
    contextTokens: 0,
    contextRemaining: 0,
    contextPercent: 0,
    lastTokenUsage: null,
    totalTokenUsage: null,
    compactEstimate: null,
    rateLimits: null
  };
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      value = parseCodexUsageLine(JSON.parse(line), value);
    } catch {
      // Ignore malformed historical lines.
    }
  }
  codexUsageCache.set(codexSession.file, { mtimeMs: info.mtimeMs, size: info.size, value });
  return value;
}

async function runtimeInfo(session) {
  const child = running.get(session.id);
  const rootPid = child?.pid || 0;
  const startedAt = session.activeRun?.startedAt || '';
  const uptimeMs = startedAt ? Math.max(0, Date.now() - Date.parse(startedAt)) : 0;
  const [processes, codexUsage, service] = await Promise.all([
    processTree(rootPid),
    codexUsageInfo(session.codexSessionId),
    serviceRuntimeInfo()
  ]);
  return {
    session: publicSession(session),
    running: Boolean(child),
    pid: rootPid,
    killed: child?.killed === true,
    exitCode: child?.exitCode ?? null,
    signalCode: child?.signalCode ?? null,
    activeRun: session.activeRun ? {
      ...session.activeRun,
      prompt: summarizeRunPrompt(session.activeRun),
      imageCount: session.activeRun.imagePaths?.length || 0,
      imagePaths: undefined
    } : null,
    queue: session.queue || [],
    uptimeMs,
    processCount: processes.length,
    memoryKb: processes.reduce((sum, item) => sum + (item.memoryKb || 0), 0),
    cpuMs: processes.reduce((sum, item) => sum + (item.cpuMs || 0), 0),
    processes,
    codexUsage,
    service,
    checkedAt: nowIso()
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
    trashedAt: state.hiddenCodexSessions?.[session.codexSessionId] || '',
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

async function collectFiles(root, out = []) {
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) await collectFiles(full, out);
    else if (entry.isFile()) {
      try {
        const info = await stat(full);
        out.push({ path: full, name: entry.name, size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        // Ignore files that disappear during scanning.
      }
    }
  }
  return out;
}

async function directoryBytes(root) {
  const files = await collectFiles(root);
  return files.reduce((sum, file) => sum + file.size, 0);
}

function referencedUploadNames() {
  const refs = new Set();
  const addImage = (image) => {
    if (!image) return;
    if (image.fileName) refs.add(image.fileName);
    if (image.path) refs.add(path.basename(image.path));
    if (image.url) refs.add(path.basename(decodeURIComponent(String(image.url).split('/').pop() || '')));
  };
  for (const session of Object.values(state.sessions || {})) {
    for (const message of session.messages || []) for (const image of message.images || []) addImage(image);
    for (const item of session.queue || []) for (const image of item.images || []) addImage(image);
  }
  return refs;
}

async function storageStats() {
  const [dataBytes, uploadFiles, runtimeBytes] = await Promise.all([
    directoryBytes(DATA_DIR),
    collectFiles(UPLOAD_DIR),
    directoryBytes(RUNTIME_DIR)
  ]);
  let stateBytes = 0;
  try {
    stateBytes = (await stat(STATE_FILE)).size;
  } catch {
    stateBytes = 0;
  }
  let disk = null;
  try {
    const info = await statfs(__dirname);
    disk = {
      totalBytes: info.blocks * info.bsize,
      freeBytes: info.bavail * info.bsize
    };
  } catch {
    disk = null;
  }
  const refs = referencedUploadNames();
  const uploadBytes = uploadFiles.reduce((sum, file) => sum + file.size, 0);
  const orphanFiles = uploadFiles.filter((file) => !refs.has(file.name));
  return {
    settings: normalizeStorageSettings(state.storageSettings),
    dataBytes,
    uploadBytes,
    uploadCount: uploadFiles.length,
    orphanUploadBytes: orphanFiles.reduce((sum, file) => sum + file.size, 0),
    orphanUploadCount: orphanFiles.length,
    runtimeBytes,
    stateBytes,
    disk,
    updatedAt: nowIso()
  };
}

async function packageMeta() {
  if (packageMetaCache) return packageMetaCache;
  try {
    const pkg = JSON.parse(await readFile(path.join(__dirname, 'package.json'), 'utf8'));
    packageMetaCache = {
      name: String(pkg.name || 'codex-mobile-console'),
      version: String(pkg.version || '')
    };
  } catch {
    packageMetaCache = { name: 'codex-mobile-console', version: '' };
  }
  return packageMetaCache;
}

async function serviceRuntimeInfo() {
  const [pkg, diskInfo] = await Promise.all([
    packageMeta(),
    statfs(__dirname).catch(() => null)
  ]);
  const memory = process.memoryUsage();
  const disk = diskInfo ? {
    totalBytes: diskInfo.blocks * diskInfo.bsize,
    freeBytes: diskInfo.bavail * diskInfo.bsize
  } : null;
  return {
    name: pkg.name,
    version: pkg.version,
    pid: process.pid,
    node: process.version,
    host: HOST,
    port: PORT,
    startedAt: SERVICE_STARTED_AT,
    uptimeMs: Math.round(process.uptime() * 1000),
    memory: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external
    },
    activeRequests,
    totalRequests,
    sseClients: [...clients.values()].reduce((sum, set) => sum + set.size, 0),
    runningSessions: running.size,
    sessionCount: Object.keys(state.sessions || {}).length,
    authSessionCount: Object.keys(state.authSessions || {}).length,
    dataDir: DATA_DIR,
    codexHome: CODEX_HOME,
    codexBin: CODEX_BIN,
    disk
  };
}

async function cleanupStorage(mode = 'all', options = {}) {
  const settings = normalizeStorageSettings(state.storageSettings);
  const result = {
    mode,
    deletedFiles: 0,
    deletedBytes: 0,
    skippedReferencedUploads: 0,
    autoCleanup: options.auto === true
  };
  if (mode === 'all' || mode === 'orphanUploads' || mode === 'uploads') {
    const uploadResult = await cleanupUploads(settings, options);
    Object.assign(result, {
      deletedFiles: result.deletedFiles + uploadResult.deletedFiles,
      deletedBytes: result.deletedBytes + uploadResult.deletedBytes,
      skippedReferencedUploads: uploadResult.skippedReferencedUploads
    });
  }
  if (mode === 'all' || mode === 'runtime') {
    const runtimeResult = await cleanupRuntime(settings, options);
    result.deletedFiles += runtimeResult.deletedFiles;
    result.deletedBytes += runtimeResult.deletedBytes;
  }
  return result;
}

async function cleanupUploads(settings, options = {}) {
  const refs = referencedUploadNames();
  const files = await collectFiles(UPLOAD_DIR);
  const now = Date.now();
  const maxBytes = settings.maxUploadMb > 0 ? settings.maxUploadMb * 1024 * 1024 : Infinity;
  const retentionMs = settings.uploadRetentionDays > 0 ? settings.uploadRetentionDays * 24 * 60 * 60 * 1000 : Infinity;
  const candidates = files
    .filter((file) => !refs.has(file.name))
    .filter((file) => options.manual === true || now - file.mtimeMs > retentionMs)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const overLimit = totalBytes > maxBytes;
  const selected = [];
  for (const file of candidates) {
    if (options.manual === true || overLimit || now - file.mtimeMs > retentionMs) {
      selected.push(file);
      totalBytes -= file.size;
      if (!options.manual && totalBytes <= maxBytes && retentionMs === Infinity) break;
    }
  }
  const result = { deletedFiles: 0, deletedBytes: 0, skippedReferencedUploads: files.length - candidates.length };
  for (const file of selected) {
    try {
      await unlink(file.path);
      result.deletedFiles += 1;
      result.deletedBytes += file.size;
    } catch {
      // Ignore files already gone.
    }
  }
  return result;
}

async function cleanupRuntime(settings, options = {}) {
  const files = await collectFiles(RUNTIME_DIR);
  const retentionMs = options.manual === true || settings.runtimeRetentionDays <= 0
    ? 0
    : settings.runtimeRetentionDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const result = { deletedFiles: 0, deletedBytes: 0 };
  for (const file of files) {
    if (retentionMs && now - file.mtimeMs <= retentionMs) continue;
    try {
      await unlink(file.path);
      result.deletedFiles += 1;
      result.deletedBytes += file.size;
    } catch {
      // Ignore files already gone.
    }
  }
  return result;
}

let storageMaintenanceTimer = null;
function startStorageMaintenance() {
  clearInterval(storageMaintenanceTimer);
  storageMaintenanceTimer = setInterval(() => {
    if (normalizeStorageSettings(state.storageSettings).autoCleanup) {
      cleanupStorage('all', { auto: true }).catch(console.error);
    }
  }, 24 * 60 * 60 * 1000);
  storageMaintenanceTimer.unref();
  if (normalizeStorageSettings(state.storageSettings).autoCleanup) {
    cleanupStorage('all', { auto: true }).catch(console.error);
  }
}

let runMonitorTimer = null;
function startRunMonitor() {
  clearInterval(runMonitorTimer);
  runMonitorTimer = setInterval(() => {
    for (const session of Object.values(state.sessions || {})) {
      reconcileSessionRunState(session, 'monitor');
    }
  }, 10000);
  runMonitorTimer.unref();
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

function parseSkillMarkdown(raw, fallbackName) {
  const text = String(raw || '');
  const meta = {};
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (match) {
    for (const line of match[1].split('\n')) {
      const item = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (item) meta[item[1]] = item[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim() || '';
  return {
    name: meta.name || fallbackName,
    description: meta.description || meta['short-description'] || '',
    title: heading || meta.name || fallbackName,
    shortDescription: meta['short-description'] || ''
  };
}

function defaultSkillRegistry() {
  return {
    version: 1,
    roots: SKILL_ROOTS,
    skills: [],
    lastScanAt: '',
    scanStatus: 'idle',
    scanError: ''
  };
}

function normalizeSkillRegistry(value = {}) {
  const parsed = value && typeof value === 'object' ? value : {};
  const version = Number(parsed.version || 1);
  return {
    ...defaultSkillRegistry(),
    version: Number.isFinite(version) ? version : 1,
    roots: SKILL_ROOTS,
    skills: Array.isArray(parsed.skills) ? parsed.skills : [],
    lastScanAt: typeof parsed.lastScanAt === 'string' ? parsed.lastScanAt : '',
    scanStatus: ['idle', 'scanning', 'error'].includes(parsed.scanStatus) ? parsed.scanStatus : 'idle',
    scanError: typeof parsed.scanError === 'string' ? parsed.scanError : ''
  };
}

async function loadSkillRegistry() {
  try {
    const parsed = JSON.parse(await readFile(SKILL_REGISTRY_FILE, 'utf8'));
    skillRegistry = normalizeSkillRegistry(parsed);
    const info = await stat(SKILL_REGISTRY_FILE);
    skillRegistryFileMtimeMs = info.mtimeMs;
  } catch {
    skillRegistry = defaultSkillRegistry();
    skillRegistryFileMtimeMs = 0;
  }
}

async function saveSkillRegistry() {
  skillRegistry = normalizeSkillRegistry(skillRegistry);
  const tmp = `${SKILL_REGISTRY_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(skillRegistry, null, 2), { mode: 0o600 });
  await rename(tmp, SKILL_REGISTRY_FILE);
  const info = await stat(SKILL_REGISTRY_FILE);
  skillRegistryFileMtimeMs = info.mtimeMs;
}

async function reloadSkillRegistryIfChanged() {
  try {
    const info = await stat(SKILL_REGISTRY_FILE);
    if (info.mtimeMs !== skillRegistryFileMtimeMs) await loadSkillRegistry();
  } catch {
    if (skillRegistryFileMtimeMs !== 0) await loadSkillRegistry();
  }
}

function publicSkillRegistry() {
  const pendingSummarySkills = (skillRegistry.skills || []).filter((skill) => skill.summaryStatus !== 'ready');
  return {
    roots: skillRegistry.roots,
    skills: skillRegistry.skills,
    lastScanAt: skillRegistry.lastScanAt,
    scanStatus: skillRegistry.scanStatus,
    scanError: skillRegistry.scanError,
    pendingSummaryCount: pendingSummarySkills.length,
    summaryPrompt: pendingSummarySkills.length ? skillSummaryPrompt(pendingSummarySkills) : ''
  };
}

function skillContentHash(raw) {
  return createHash('sha256').update(String(raw || '')).digest('hex');
}

function skillSource(root, file) {
  const normalizedRoot = path.resolve(root);
  const normalizedFile = path.resolve(file);
  const relative = path.relative(normalizedRoot, normalizedFile);
  const parts = relative.split(path.sep).filter(Boolean);
  const system = parts.includes('.system');
  if (normalizedRoot.includes(`${path.sep}.agents${path.sep}`)) return system ? 'agents-system' : 'agents';
  return system ? 'codex-system' : 'codex';
}

async function walkSkillFiles(root, out = [], limit = 200) {
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
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      await walkSkillFiles(full, out, limit);
    } else if (entry.isFile() && entry.name === 'SKILL.md') {
      out.push(full);
    }
  }
  return out;
}

async function listInstalledSkills() {
  const byName = new Map();
  for (const root of SKILL_ROOTS) {
    const files = await walkSkillFiles(root);
    for (const file of files) {
      try {
        const raw = await readFile(file, 'utf8');
        const info = await stat(file);
        const fallbackName = path.basename(path.dirname(file));
        const parsed = parseSkillMarkdown(raw, fallbackName);
        const source = skillSource(root, file);
        const skill = {
          name: parsed.name,
          title: parsed.title,
          description: parsed.description,
          shortDescription: parsed.shortDescription,
          source,
          system: source.includes('system'),
          path: file,
          hash: skillContentHash(raw),
          updatedAt: new Date(info.mtimeMs).toISOString()
        };
        const existing = byName.get(skill.name);
        if (!existing || existing.system && !skill.system) byName.set(skill.name, skill);
      } catch {
        // Ignore unreadable skill files; the rest of the list is still useful.
      }
    }
  }
  return [...byName.values()].sort((a, b) => {
    if (a.system !== b.system) return a.system ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

function refreshSkillRegistry() {
  if (skillScanPromise) return skillScanPromise;
  skillScanPromise = Promise.resolve()
    .then(async () => {
      await reloadSkillRegistryIfChanged();
      skillRegistry.scanStatus = 'scanning';
      skillRegistry.scanError = '';
      await saveSkillRegistry().catch(() => {});
      const skills = await listInstalledSkills();
      const previous = new Map((skillRegistry.skills || []).map((skill) => [`${skill.source}:${skill.name}`, skill]));
      skillRegistry = {
        ...skillRegistry,
        version: 1,
        roots: SKILL_ROOTS,
        skills: skills.map((skill) => {
          const old = previous.get(`${skill.source}:${skill.name}`);
          return {
            ...skill,
            summary: old?.hash === skill.hash ? old.summary || null : null,
            summaryStatus: old?.hash === skill.hash && old?.summary ? 'ready' : 'pending',
            summaryUpdatedAt: old?.hash === skill.hash ? old?.summaryUpdatedAt || '' : ''
          };
        }),
        lastScanAt: nowIso(),
        scanStatus: 'idle',
        scanError: ''
      };
      await saveSkillRegistry();
    })
    .catch(async (error) => {
      skillRegistry.scanStatus = 'error';
      skillRegistry.scanError = String(error.message || error).slice(0, 300);
      await saveSkillRegistry().catch(() => {});
    })
    .finally(() => {
      skillScanPromise = null;
    });
  return skillScanPromise;
}

function startSkillMaintenance() {
  clearInterval(skillMaintenanceTimer);
  setTimeout(() => {
    refreshSkillRegistry().catch(() => {});
  }, 2000).unref();
  skillMaintenanceTimer = setInterval(() => {
    refreshSkillRegistry().catch(() => {});
  }, 15 * 60 * 1000);
  skillMaintenanceTimer.unref();
}

function skillSummaryPrompt(skills) {
  const targets = skills.map((skill) => ({
    name: skill.name,
    source: skill.source,
    path: skill.path,
    hash: skill.hash,
    title: skill.title || skill.name,
    description: skill.description || skill.shortDescription || ''
  }));
  return [
    '请更新 Codex Mobile Console 的 skill 中文总结缓存。',
    '',
    '要求：',
    '1. 读取下面每个 skill 的 SKILL.md 文件。',
    '2. 更新 /root/Projects/codex-mobile-console/data/skill-registry.json 中对应 skill 的 summary、summaryStatus、summaryUpdatedAt 字段。',
    '3. summary 格式为 {"title":"一句话标题","overview":"80字以内介绍","bullets":["适用场景","使用方式","实现要点"]}。',
    '4. 不要直接展示或大段复述 SKILL.md 原文。',
    '5. 只更新 hash 匹配的条目；如果文件 hash 已变化，先重新计算并以当前文件为准。',
    '6. 所有下面列出的待更新 skill 都要一次性更新，不要分批。',
    '7. 保留 registry 文件里和本次总结无关的字段，不要重启服务，不要调用应用内接口。',
    '',
    `待更新 skill JSON:\n${JSON.stringify(targets, null, 2)}`
  ].join('\n');
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

function codexSessionFilePath(codexSessionId, date = new Date()) {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const stamp = date.toISOString().replace(/\.\d{3}Z$/, '').replaceAll(':', '-');
  return path.join(CODEX_HOME, 'sessions', year, month, day, `rollout-${stamp}-${codexSessionId}.jsonl`);
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

  let info;
  try {
    info = await stat(session.file);
  } catch {
    return [];
  }
  const cached = codexMessagesCache.get(session.file);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return cached.messages.map((message) => ({
      ...message,
      starred: message.starred === true || state.starredMessages?.[message.id] === true
    }));
  }

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

  codexMessagesCache.set(session.file, { mtimeMs: info.mtimeMs, size: info.size, messages });
  if (codexMessagesCache.size > 20) {
    const firstKey = codexMessagesCache.keys().next().value;
    codexMessagesCache.delete(firstKey);
  }
  return messages.map((message) => ({ ...message }));
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

function forkTitle(title = '') {
  const base = String(title || '').trim() || 'Codex session';
  return `${base.replace(/\s+fork(?: \d+)?$/i, '')} fork`.slice(0, 80);
}

async function forkCodexSession(codexSessionId, title = '') {
  const source = await findCodexSession(codexSessionId);
  if (!source?.file) return null;

  const sessionsRoot = path.resolve(CODEX_HOME, 'sessions');
  const sourceFile = path.resolve(source.file);
  if (!sourceFile.startsWith(`${sessionsRoot}${path.sep}`)) throw new Error('invalid_codex_session_path');

  const newCodexSessionId = randomUUID();
  const createdAt = new Date();
  const newFile = codexSessionFilePath(newCodexSessionId, createdAt);
  await mkdir(path.dirname(newFile), { recursive: true });

  const raw = await readFile(sourceFile, 'utf8');
  let rewroteMeta = false;
  const lines = raw.split('\n').map((line) => {
    if (!line.trim()) return line;
    try {
      const item = JSON.parse(line);
      if (item.type !== 'session_meta') return line;
      item.timestamp = createdAt.toISOString();
      item.payload ||= {};
      item.payload.id = newCodexSessionId;
      item.payload.timestamp = createdAt.toISOString();
      item.payload.forked_from = codexSessionId;
      item.payload.forked_from_id = codexSessionId;
      rewroteMeta = true;
      return JSON.stringify(item);
    } catch {
      return line;
    }
  });
  if (!rewroteMeta) throw new Error('codex_session_meta_not_found');

  await writeFile(newFile, lines.join('\n'), { mode: 0o600 });
  let shellSnapshotCount = 0;
  const snapshotDir = path.join(CODEX_HOME, 'shell_snapshots');
  try {
    await mkdir(snapshotDir, { recursive: true });
    const snapshots = await readdir(snapshotDir, { withFileTypes: true });
    await Promise.all(snapshots
      .filter((entry) => entry.isFile() && entry.name.startsWith(`${codexSessionId}.`) && entry.name.endsWith('.sh'))
      .slice(0, 200)
      .map(async (entry) => {
        const suffix = entry.name.slice(codexSessionId.length);
        await copyFile(path.join(snapshotDir, entry.name), path.join(snapshotDir, `${newCodexSessionId}${suffix}`));
        shellSnapshotCount += 1;
      }));
  } catch {
    shellSnapshotCount = 0;
  }
  const nextTitle = forkTitle(title || source.title);
  state.codexSessionTitles ||= {};
  state.codexSessionTitles[newCodexSessionId] = nextTitle;
  await appendFile(
    path.join(CODEX_HOME, 'session_index.jsonl'),
    `${JSON.stringify({ id: newCodexSessionId, thread_name: nextTitle, updated_at: createdAt.toISOString() })}\n`,
    { mode: 0o600 }
  );
  return {
    codexSessionId: newCodexSessionId,
    title: nextTitle,
    cwd: source.cwd,
    file: newFile,
    shellSnapshotCount,
    sourceCodexSessionId: codexSessionId
  };
}

async function displayMessages(session, limit = 500) {
  const page = await displayMessagePage(session, { limit, offset: 0 });
  return page.messages;
}

function displayMessageText(message) {
  return String(message?.text || '').replace(/\s+/g, ' ').trim();
}

function displayMessageTime(message) {
  const value = Date.parse(message?.at || '');
  return Number.isFinite(value) ? value : 0;
}

function displayIsCodex(message) {
  return message?.source === 'codex';
}

function sameDisplayMessage(left, right) {
  if (!left || !right) return false;
  if ((left.role || '') !== (right.role || '')) return false;
  const text = displayMessageText(left);
  if (!text || text !== displayMessageText(right)) return false;
  if (displayIsCodex(left) === displayIsCodex(right) && !displayIsCodex(left)) return false;
  const leftAt = displayMessageTime(left);
  const rightAt = displayMessageTime(right);
  if (!leftAt || !rightAt) return true;
  return Math.abs(leftAt - rightAt) <= 5 * 60 * 1000;
}

function displayMessageDedupeKey(message) {
  const text = displayMessageText(message);
  if (!text) return '';
  return `${message.role || ''}\0${text}`;
}

function mergeDisplayMessage(existing, incoming) {
  const preferExisting = !displayIsCodex(existing) && displayIsCodex(incoming);
  const base = preferExisting ? incoming : existing;
  const overlay = preferExisting ? existing : incoming;
  const next = { ...base, ...overlay };
  const existingImages = existing.images || [];
  const incomingImages = incoming.images || [];
  next.images = existingImages.length >= incomingImages.length ? existingImages : incomingImages;
  next.starred = existing.starred === true || incoming.starred === true;
  return next;
}

function compareDisplayMessages(a, b) {
  const byTime = displayMessageTime(a) - displayMessageTime(b);
  if (byTime) return byTime;
  return Number(a.seq || 0) - Number(b.seq || 0);
}

async function indexedDisplayMessages(session) {
  const codexMessages = session.codexSessionId ? await readCodexMessages(session.codexSessionId) : [];
  const out = [];
  const byDedupeKey = new Map();
  for (const message of [...codexMessages, ...(session.messages || [])]) {
    const next = {
      ...message,
      starred: message.starred === true || state.starredMessages?.[message.id] === true
    };
    const dedupeKey = displayMessageDedupeKey(next);
    const candidates = dedupeKey ? byDedupeKey.get(dedupeKey) || [] : [];
    const index = candidates.find((candidateIndex) => sameDisplayMessage(out[candidateIndex], next)) ?? -1;
    if (index >= 0) {
      out[index] = mergeDisplayMessage(out[index], next);
      continue;
    }
    out.push(next);
    if (dedupeKey) {
      candidates.push(out.length - 1);
      byDedupeKey.set(dedupeKey, candidates);
    }
  }
  return out.sort(compareDisplayMessages).map((message, index) => ({
    ...message,
    orderSeq: index + 1
  }));
}

function normalizeMessageQueryLimit(value, fallback = 500) {
  const raw = Number(value ?? fallback);
  return Number.isFinite(raw) ? Math.max(0, Math.min(5000, Math.floor(raw))) : fallback;
}

function normalizeMessageQueryOffset(value) {
  const raw = Number(value ?? 0);
  return Number.isFinite(raw) ? Math.max(0, Math.min(50000, Math.floor(raw))) : 0;
}

async function displayMessagePage(session, options = {}) {
  const limit = normalizeMessageQueryLimit(options.limit, 500);
  const offset = normalizeMessageQueryOffset(options.offset);
  const sorted = await indexedDisplayMessages(session);
  const total = sorted.length;
  const end = Math.max(0, total - offset);
  const start = limit > 0 ? Math.max(0, end - limit) : 0;
  const messages = sorted.slice(start, end);
  return {
    messages,
    limit,
    offset,
    loaded: messages.length,
    total,
    nextOffset: offset + messages.length,
    hasMore: start > 0
  };
}

async function displayMessageRange(session, options = {}) {
  const limit = normalizeMessageQueryLimit(options.limit, 120);
  const sorted = await indexedDisplayMessages(session);
  const total = sorted.length;
  const firstSeq = sorted[0]?.orderSeq || 0;
  const latestSeq = sorted.at(-1)?.orderSeq || 0;
  const afterSeq = Number(options.afterSeq || 0);
  const beforeSeq = Number(options.beforeSeq || 0);
  const previousTurn = options.previousTurn === true || options.previousTurn === '1' || options.previousTurn === 'true';

  if (Number.isFinite(afterSeq) && afterSeq > 0) {
    const messages = sorted.filter((message) => Number(message.orderSeq || 0) > afterSeq).slice(0, limit);
    return {
      messages,
      limit,
      total,
      firstSeq,
      latestSeq,
      beforeSeq: messages[0]?.orderSeq || 0,
      afterSeq,
      hasMoreBefore: Boolean(messages.length && messages[0].orderSeq > firstSeq),
      hasMoreAfter: Boolean(messages.length && messages.at(-1).orderSeq < latestSeq)
    };
  }

  const endIndex = Number.isFinite(beforeSeq) && beforeSeq > 0
    ? sorted.findIndex((message) => Number(message.orderSeq || 0) >= beforeSeq)
    : sorted.length;
  const end = endIndex < 0 ? sorted.length : Math.max(0, endIndex);
  let start = limit > 0 ? Math.max(0, end - limit) : 0;
  if (previousTurn) {
    start = Math.max(0, end - 1);
    while (start > 0 && sorted[start]?.role !== 'user') start -= 1;
  }
  const messages = sorted.slice(start, end);
  return {
    messages,
    limit,
    total,
    firstSeq,
    latestSeq,
    beforeSeq: messages[0]?.orderSeq || 0,
    afterSeq: messages.at(-1)?.orderSeq || 0,
    hasMoreBefore: start > 0,
    hasMoreAfter: end < sorted.length
  };
}

async function listCodexSessions() {
  const names = await readCodexThreadNames();
  const files = await walkFiles(path.join(CODEX_HOME, 'sessions'));
  const imported = new Set(Object.values(state.sessions || {}).map((session) => session.codexSessionId).filter(Boolean));
  const byId = new Map();
  for (const file of files) {
    try {
      const session = await readCodexSessionFile(file, names);
      if (!session || imported.has(session.codexSessionId)) continue;
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

async function importCodexSession(codexSessionId, options = {}) {
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
    title: options.title || state.codexSessionTitles?.[codexSessionId] || external.title || `Codex ${codexSessionId.slice(0, 8)}`,
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
    text: options.systemText || `Imported Codex thread ${codexSessionId}. Loaded ${history.length} saved messages.`
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
  session.messages ||= [];
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
  broadcastEvent(sessionId, 'message', message);
}

function broadcastSession(session) {
  if (!session?.id) return;
  broadcastEvent(session.id, 'session', publicSession(session));
}

function broadcastEvent(sessionId, event, data) {
  const set = clients.get(sessionId);
  if (!set) return;
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of [...set]) {
    if (res.destroyed || res.writableEnded) {
      set.delete(res);
      continue;
    }
    try {
      res.write(line);
    } catch {
      set.delete(res);
    }
  }
  if (set.size === 0) clients.delete(sessionId);
}

function sendSse(res, event, data) {
  if (res.destroyed || res.writableEnded) return false;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

async function requestServiceRestart(reason = 'api') {
  await writeRestartMarker(reason);
  restartRequested = true;
  if (running.size > 0) return { queued: true, running: running.size };
  scheduleServiceRestart();
  return { queued: false, running: 0 };
}

function scheduleServiceRestart() {
  if (!restartRequested || running.size > 0) return;
  restartRequested = false;
  setTimeout(() => {
    const child = spawn('/bin/systemctl', ['restart', 'codex-mobile-console.service'], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
  }, 250).unref();
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
  session.activeRun = {
    prompt,
    elevated: options.elevated === true,
    imagePaths: options.imagePaths || [],
    messageId: options.messageId || '',
    clientMessageId: options.clientMessageId || '',
    startedAt: nowIso()
  };
  updateMessageRunState(session, options.messageId || options.clientMessageId, 'running', { delivery: 'running' });
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
  broadcastSession(session);

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
    updateMessageRunState(session, session.activeRun?.messageId || session.activeRun?.clientMessageId, 'failed', { delivery: 'failed' });
    delete session.activeRun;
    addMessage(session, {
      role: 'system',
      text: `Failed to start Codex: ${error.message}`,
      status: 'error'
    });
    broadcastSession(session);
    scheduleSave();
  });

  child.on('close', (code) => {
    if (!running.has(session.id) && session.status === 'error') return;
    if (stdoutBuffer.trim()) handleCodexLine(session, stdoutBuffer);
    running.delete(session.id);
    const wasStopping = session.status === 'stopping';
    const next = !wasStopping ? session.queue?.shift() : null;
    const nextStatus = next?.prompt ? 'running' : code === 0 || wasStopping ? 'idle' : 'error';
    const finalRunState = wasStopping ? 'stopped' : code === 0 ? 'completed' : 'failed';
    updateMessageRunState(session, session.activeRun?.messageId || session.activeRun?.clientMessageId, finalRunState, {
      delivery: finalRunState
    });
    session.status = nextStatus;
    session.updatedAt = nowIso();
    addMessage(session, {
      role: 'system',
      text: next?.prompt ? 'Codex run finished. Starting next queued prompt.' : wasStopping ? 'Codex run stopped.' : code === 0 ? 'Codex run finished.' : `Codex exited with code ${code}.`,
      status: nextStatus,
      queuedCount: session.queue?.length || 0
    });
    broadcastSession(session);

    if (next?.prompt) {
      scheduleSave();
      runCodex(session, next.prompt, {
        elevated: next.elevated,
        imagePaths: (next.images || []).map((image) => image.path),
        messageId: next.messageId,
        clientMessageId: next.clientMessageId
      });
      return;
    }

    delete session.activeRun;
    scheduleSave();
    scheduleServiceRestart();
  });
}

function stopRunningSession(session) {
  const child = running.get(session.id);
  if (!child) return false;

  session.status = 'stopping';
  session.updatedAt = nowIso();
  const queuedCount = session.queue?.length || 0;
  if (queuedCount) session.queue = [];
  updateMessageRunState(session, session.activeRun?.messageId || session.activeRun?.clientMessageId, 'stopping', { delivery: 'stopping' });
  for (const message of incompleteRunMessages(session)) {
    if (message.runState === 'queued') updateMessageRunState(session, message.id, 'stopped', { delivery: 'stopped' });
  }
  addMessage(session, {
    role: 'system',
    text: queuedCount ? `Stop requested. Cleared ${queuedCount} queued prompt${queuedCount === 1 ? '' : 's'}.` : 'Stop requested.',
    status: 'stopping',
    queuedCount: 0
  });
  broadcastSession(session);

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

  if (url.pathname === '/api/storage' && req.method === 'GET') {
    return json(res, 200, await storageStats());
  }

  if (url.pathname === '/api/storage' && req.method === 'PATCH') {
    const body = await readJson(req);
    state.storageSettings = normalizeStorageSettings({
      ...state.storageSettings,
      ...body
    });
    scheduleSave();
    startStorageMaintenance();
    return json(res, 200, await storageStats());
  }

  if (url.pathname === '/api/storage/cleanup' && req.method === 'POST') {
    const body = await readJson(req);
    const mode = ['all', 'orphanUploads', 'runtime'].includes(body.mode) ? body.mode : 'all';
    const result = await cleanupStorage(mode, { manual: true });
    return json(res, 200, { ok: true, result, storage: await storageStats() });
  }

  if (url.pathname === '/api/skills' && req.method === 'GET') {
    await reloadSkillRegistryIfChanged();
    return json(res, 200, publicSkillRegistry());
  }

  if (url.pathname === '/api/skills/refresh' && req.method === 'POST') {
    refreshSkillRegistry().catch(() => {});
    return json(res, 202, {
      ok: true,
      ...publicSkillRegistry(),
      scanStatus: skillScanPromise ? 'scanning' : skillRegistry.scanStatus
    });
  }

  if (url.pathname === '/api/admin/restart' && req.method === 'POST') {
    const body = req.method === 'POST' ? await readJson(req).catch(() => ({})) : {};
    const result = await requestServiceRestart(String(body.reason || 'api').slice(0, 80));
    return json(res, 202, { ok: true, ...result });
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

  const messageListMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (messageListMatch && req.method === 'GET') {
    const session = state.sessions[decodeURIComponent(messageListMatch[1])];
    if (!session) return json(res, 404, { error: 'session_not_found' });
    reconcileSessionRunState(session, 'message-list');
    const range = await displayMessageRange(session, {
      limit: url.searchParams.get('limit'),
      beforeSeq: url.searchParams.get('beforeSeq'),
      afterSeq: url.searchParams.get('afterSeq'),
      previousTurn: url.searchParams.get('previousTurn')
    });
    return json(res, 200, { session: publicSession(session), ...range });
  }

  if (url.pathname === '/api/projects') {
    const projectsRoot = process.env.PROJECTS_ROOT || '/root/Projects';
    return json(res, 200, {
      roots: [projectsRoot, '/root/data/disk/Projects'],
      defaultCwd: projectsRoot
    });
  }

  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    for (const session of Object.values(state.sessions)) reconcileSessionRunState(session, 'session-list');
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
    reconcileSessionRunState(session, 'session-load');
    const rawLimit = Number(url.searchParams.get('limit') ?? 500);
    const rawOffset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number.isFinite(rawLimit) ? Math.max(0, Math.min(5000, Math.floor(rawLimit))) : 500;
    const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.min(50000, Math.floor(rawOffset))) : 0;
    const page = await displayMessagePage(session, { limit, offset });
    return json(res, 200, { session: publicSession(session), ...page });
  }

  const runtimeMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/runtime$/);
  if (runtimeMatch && req.method === 'GET') {
    const session = state.sessions[decodeURIComponent(runtimeMatch[1])];
    if (!session) return json(res, 404, { error: 'session_not_found' });
    reconcileSessionRunState(session, 'runtime');
    return json(res, 200, await runtimeInfo(session));
  }

  const forkMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/fork$/);
  if (forkMatch && req.method === 'POST') {
    const sessionId = decodeURIComponent(forkMatch[1]);
    const body = await readJson(req).catch(() => ({}));
    let codexSessionId = '';
    let sourceTitle = '';
    let sourceSession = null;

    if (sessionId.startsWith('codex:')) {
      codexSessionId = sessionId.slice('codex:'.length);
      const external = await findCodexSession(codexSessionId);
      if (!external) return json(res, 404, { error: 'codex_session_not_found' });
      sourceTitle = state.codexSessionTitles?.[codexSessionId] || external.title || '';
    } else {
      sourceSession = state.sessions[sessionId];
      if (!sourceSession) return json(res, 404, { error: 'session_not_found' });
      reconcileSessionRunState(sourceSession, 'fork');
      if (running.has(sessionId) || ['running', 'stopping'].includes(sourceSession.status)) {
        return json(res, 409, { error: 'session_running', message: '会话正在运行，停止或等待结束后再 fork。' });
      }
      codexSessionId = sourceSession.codexSessionId || '';
      sourceTitle = sourceSession.title || '';
      if (!codexSessionId) {
        return json(res, 409, { error: 'codex_session_missing', message: '当前会话还没有绑定 Codex 原始会话，先运行一次后再 fork。' });
      }
    }

    const forked = await forkCodexSession(codexSessionId, String(body.title || sourceTitle || ''));
    if (!forked) return json(res, 404, { error: 'codex_session_not_found' });
    const session = await importCodexSession(forked.codexSessionId, {
      title: forked.title,
      systemText: `Forked Codex thread ${codexSessionId} into ${forked.codexSessionId}.`
    });
    if (!session) return json(res, 500, { error: 'fork_import_failed' });
    session.model = sourceSession?.model || session.model || '';
    session.sandbox = sourceSession?.sandbox || session.sandbox || 'workspace-write';
    session.approval = sourceSession?.approval || session.approval || 'on-request';
    session.updatedAt = nowIso();
    scheduleSave();
    return json(res, 201, { ok: true, forked, session: publicSession(session) });
  }

  const restoreMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/restore$/);
  if (restoreMatch && req.method === 'POST') {
    const sessionId = decodeURIComponent(restoreMatch[1]);
    if (sessionId.startsWith('codex:')) {
      const codexSessionId = sessionId.slice('codex:'.length);
      delete state.hiddenCodexSessions?.[codexSessionId];
      scheduleSave();
      const external = await findCodexSession(codexSessionId);
      return json(res, 200, {
        ok: true,
        session: publicExternalSession(external || { codexSessionId, title: state.codexSessionTitles?.[codexSessionId] || `Codex ${codexSessionId.slice(0, 8)}`, cwd: '', updatedAt: nowIso(), createdAt: nowIso() })
      });
    }

    const session = state.sessions[sessionId];
    if (!session) return json(res, 404, { error: 'session_not_found' });
    delete session.trashedAt;
    session.updatedAt = nowIso();
    scheduleSave();
    return json(res, 200, { ok: true, session: publicSession(session) });
  }

  if (sessionMatch && req.method === 'DELETE') {
    const sessionId = decodeURIComponent(sessionMatch[1]);
    const body = await readJson(req);
    if (sessionId.startsWith('codex:')) {
      const codexSessionId = sessionId.slice('codex:'.length);
      let deletedCodex = false;
      if (body.permanent === true) {
        deletedCodex = await deleteCodexSessionFile(codexSessionId);
        delete state.hiddenCodexSessions?.[codexSessionId];
        if (state.codexSessionTitles) delete state.codexSessionTitles[codexSessionId];
      } else {
        state.hiddenCodexSessions ||= {};
        state.hiddenCodexSessions[codexSessionId] = nowIso();
      }
      scheduleSave();
      const external = body.permanent === true ? null : await findCodexSession(codexSessionId);
      return json(res, 200, {
        ok: true,
        trashed: body.permanent !== true,
        deletedCodex,
        session: external ? publicExternalSession(external) : null
      });
    }

    const session = state.sessions[sessionId];
    if (!session) return json(res, 404, { error: 'session_not_found' });
    if (running.has(sessionId)) return json(res, 409, { error: 'session_running' });
    if (body.permanent !== true) {
      session.trashedAt = nowIso();
      session.updatedAt = session.trashedAt;
      scheduleSave();
      return json(res, 200, { ok: true, trashed: true, session: publicSession(session) });
    }
    let deletedCodex = false;
    if (body.deleteCodex === true && session.codexSessionId) {
      deletedCodex = await deleteCodexSessionFile(session.codexSessionId);
      if (state.codexSessionTitles) delete state.codexSessionTitles[session.codexSessionId];
    }
    delete state.sessions[sessionId];
    await cleanupStorage('orphanUploads', { manual: true });
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
    const userMessage = addMessage(session, {
      role: 'user',
      text: effectivePrompt,
      elevated,
      clientMessageId,
      images,
      runState: running.has(session.id) ? 'queued' : 'submitted',
      delivery: running.has(session.id) ? 'queued' : 'submitted'
    });
    if (running.has(session.id)) {
      session.queue ||= [];
      session.queue.push({ id: queueId, prompt: effectivePrompt, displayPrompt: effectivePrompt, elevated, images, createdAt: nowIso(), clientMessageId, messageId: userMessage.id });
      session.updatedAt = nowIso();
      scheduleSave();
      return json(res, 202, { session: publicSession(session), queued: true });
    }
    try {
      runCodex(session, effectivePrompt, {
        elevated,
        imagePaths: images.map((image) => image.path),
        messageId: userMessage.id,
        clientMessageId
      });
    } catch (error) {
      session.status = 'error';
      updateMessageRunState(session, userMessage.id, 'failed', { delivery: 'failed' });
      addMessage(session, { role: 'system', text: String(error.message || error), status: 'error' });
    }
    return json(res, 202, { session: publicSession(session) });
  }

  const queueMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/queue\/([^/]+)$/);
  if (queueMatch && req.method === 'PATCH') {
    const session = state.sessions[decodeURIComponent(queueMatch[1])];
    if (!session) return json(res, 404, { error: 'session_not_found' });
    const queueId = decodeURIComponent(queueMatch[2]);
    const index = (session.queue || []).findIndex((item) => item.id === queueId || item.clientMessageId === queueId);
    if (index < 0) return json(res, 404, { error: 'queue_item_not_found', session: publicSession(session) });
    const body = await readJson(req);
    const item = session.queue[index];
    let message = null;

    if (body.action === 'top' && index > 0) {
      session.queue.splice(index, 1);
      session.queue.unshift(item);
    }

    if (typeof body.prompt === 'string') {
      const prompt = body.prompt.trim();
      if (!prompt) return json(res, 400, { error: 'empty_prompt' });
      item.prompt = prompt;
      item.displayPrompt = prompt;
      message = (session.messages || []).find((entry) => entry.id === item.messageId || entry.clientMessageId === item.clientMessageId);
      if (message) {
        message.text = prompt;
        message.pending = false;
        message.failed = false;
        message.updatedAt = nowIso();
        broadcastEvent(session.id, 'message_update', message);
      }
    }

    session.updatedAt = nowIso();
    scheduleSave();
    return json(res, 200, { ok: true, session: publicSession(session), message });
  }

  if (queueMatch && req.method === 'DELETE') {
    const session = state.sessions[decodeURIComponent(queueMatch[1])];
    if (!session) return json(res, 404, { error: 'session_not_found' });
    const queueId = decodeURIComponent(queueMatch[2]);
    const index = (session.queue || []).findIndex((item) => item.id === queueId || item.clientMessageId === queueId);
    if (index < 0) return json(res, 404, { error: 'queue_item_not_found', session: publicSession(session) });
    const [removed] = session.queue.splice(index, 1);
    updateMessageRunState(session, removed?.messageId || removed?.clientMessageId, 'stopped', { delivery: 'stopped' });
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
    reconcileSessionRunState(session, 'stop');
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
  sendSse(res, 'hello', { sessionId, session: publicSession(session), now: nowIso() });
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
  const cleanup = () => {
    clearInterval(ping);
    set.delete(res);
    if (set.size === 0) clients.delete(sessionId);
  };
  res.on('error', cleanup);
  res.on('close', cleanup);
  req.on('close', cleanup);
}

const server = http.createServer((req, res) => {
  totalRequests += 1;
  activeRequests += 1;
  let counted = true;
  const finishRequest = () => {
    if (!counted) return;
    counted = false;
    activeRequests = Math.max(0, activeRequests - 1);
  };
  res.on('finish', finishRequest);
  res.on('close', finishRequest);

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

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await prepareForShutdown(signal.toLowerCase());
  } catch (error) {
    console.error(error);
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
