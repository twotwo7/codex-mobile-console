import { spawn } from 'node:child_process';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';

function sqlText(value) {
  return `'${String(value ?? '').replaceAll("'", "''")}'`;
}

function runSqlite(databaseFile, sql, { json = false } = {}) {
  return new Promise((resolve, reject) => {
    const args = json ? ['-json', databaseFile] : [databaseFile];
    const child = spawn('/bin/sqlite3', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`sqlite exited with ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`));
        return;
      }
      const output = Buffer.concat(stdout).toString('utf8');
      if (!json) return resolve(output);
      try {
        resolve(output.trim() ? JSON.parse(output) : []);
      } catch (error) {
        reject(new Error(`invalid sqlite JSON output: ${error.message}`));
      }
    });
    child.stdin.end(sql);
  });
}

function sessionMessages(session) {
  return Array.isArray(session?.messages) ? session.messages : [];
}

export function stateMetadataSnapshot(state) {
  return {
    ...state,
    sessions: Object.fromEntries(Object.entries(state.sessions || {}).map(([id, session]) => [id, {
      ...session,
      messages: undefined
    }]))
  };
}

export function createSqliteMessageStore({ databaseFile }) {
  const persisted = new Map();
  const dirtySessions = new Set();

  async function initialize() {
    await mkdir(path.dirname(databaseFile), { recursive: true });
    await runSqlite(databaseFile, `
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS schema_info (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO schema_info(key, value) VALUES ('schema_version', '1')
        ON CONFLICT(key) DO UPDATE SET value=excluded.value;
      CREATE TABLE IF NOT EXISTS messages (
        session_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY(session_id, position)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, position);
    `);
    await chmod(databaseFile, 0o600).catch(() => {});
  }

  async function rowCount() {
    const rows = await runSqlite(databaseFile, 'SELECT COUNT(*) AS count FROM messages;', { json: true });
    return Number(rows[0]?.count || 0);
  }

  async function hydrateState(state) {
    if (!(await rowCount())) {
      persisted.clear();
      for (const sessionId of Object.keys(state.sessions || {})) dirtySessions.add(sessionId);
      return false;
    }
    const rows = await runSqlite(databaseFile, 'SELECT session_id, position, payload_json FROM messages ORDER BY session_id, position;', { json: true });
    const grouped = new Map();
    for (const row of rows) {
      if (!grouped.has(row.session_id)) grouped.set(row.session_id, []);
      grouped.get(row.session_id)[Number(row.position)] = String(row.payload_json || 'null');
    }
    for (const [sessionId, session] of Object.entries(state.sessions || {})) {
      const serialized = grouped.get(sessionId) || [];
      session.messages = serialized.filter((value) => value !== undefined).map((value) => JSON.parse(value));
      persisted.set(sessionId, serialized);
    }
    dirtySessions.clear();
    return true;
  }

  function markSessionDirty(sessionId) {
    if (sessionId) dirtySessions.add(String(sessionId));
  }

  async function persistMessages(state, options = {}) {
    const statements = ['BEGIN IMMEDIATE;'];
    const activeIds = new Set(Object.keys(state.sessions || {}));
    const nextPersisted = new Map();
    const deletedIds = [];

    for (const existingId of persisted.keys()) {
      if (activeIds.has(existingId)) continue;
      statements.push(`DELETE FROM messages WHERE session_id=${sqlText(existingId)};`);
      deletedIds.push(existingId);
    }

    for (const sessionId of dirtySessions) {
      const session = state.sessions?.[sessionId];
      if (!session) continue;
      const current = sessionMessages(session).map((message) => JSON.stringify(message));
      const previous = persisted.get(sessionId) || [];
      const max = Math.max(current.length, previous.length);
      for (let position = 0; position < max; position += 1) {
        if (position >= current.length) {
          statements.push(`DELETE FROM messages WHERE session_id=${sqlText(sessionId)} AND position=${position};`);
          continue;
        }
        if (current[position] === previous[position]) continue;
        statements.push(`INSERT INTO messages(session_id, position, payload_json) VALUES (${sqlText(sessionId)}, ${position}, ${sqlText(current[position])}) ON CONFLICT(session_id, position) DO UPDATE SET payload_json=excluded.payload_json;`);
      }
      nextPersisted.set(sessionId, current);
    }

    if (options.generation !== undefined) {
      statements.push(`INSERT INTO schema_info(key, value) VALUES ('state_generation', ${sqlText(options.generation)}) ON CONFLICT(key) DO UPDATE SET value=excluded.value;`);
    }
    if (statements.length === 1) return { changed: 0 };
    statements.push('COMMIT;');
    await runSqlite(databaseFile, statements.join('\n'));
    for (const existingId of deletedIds) persisted.delete(existingId);
    for (const [sessionId, current] of nextPersisted) {
      persisted.set(sessionId, current);
      dirtySessions.delete(sessionId);
    }
    await chmod(databaseFile, 0o600).catch(() => {});
    return { changed: statements.length - 2 };
  }

  async function stats() {
    const rows = await runSqlite(databaseFile, `
      SELECT
        COUNT(*) AS message_count,
        COUNT(DISTINCT session_id) AS session_count,
        COALESCE((SELECT value FROM schema_info WHERE key='state_generation'), '0') AS generation
      FROM messages;
    `, { json: true });
    return {
      messageCount: Number(rows[0]?.message_count || 0),
      sessionCount: Number(rows[0]?.session_count || 0),
      generation: Number(rows[0]?.generation || 0)
    };
  }

  return { hydrateState, initialize, markSessionDirty, persistMessages, stats };
}
