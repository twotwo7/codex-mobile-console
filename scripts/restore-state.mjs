import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const backupDir = process.argv.find((arg) => !arg.startsWith('-') && arg !== process.argv[0] && arg !== process.argv[1]);
const apply = process.argv.includes('--apply');
if (!backupDir) throw new Error('usage: node scripts/restore-state.mjs <backup-dir> [--apply]');
const source = path.resolve(backupDir);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${command} exited with ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`));
      resolve(Buffer.concat(stdout).toString('utf8'));
    });
  });
}

const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
for (const file of manifest.files || []) {
  const body = await readFile(path.join(source, file.name));
  const digest = createHash('sha256').update(body).digest('hex');
  if (body.length !== Number(file.bytes) || digest !== file.sha256) throw new Error(`backup checksum mismatch: ${file.name}`);
}

const state = JSON.parse(await readFile(path.join(source, 'state.json'), 'utf8'));
const sqliteFile = path.join(source, 'messages.sqlite3');
let databaseGeneration = 0;
try {
  await stat(sqliteFile);
  const integrity = (await run('/bin/sqlite3', [sqliteFile, 'PRAGMA integrity_check;'])).trim();
  if (integrity !== 'ok') throw new Error(`sqlite integrity check failed: ${integrity}`);
  databaseGeneration = Number((await run('/bin/sqlite3', [sqliteFile, "SELECT COALESCE((SELECT value FROM schema_info WHERE key='state_generation'), '0');"])).trim() || 0);
  if (databaseGeneration !== Number(state.storageGeneration || 0)) {
    throw new Error(`backup generation mismatch: state=${state.storageGeneration || 0} sqlite=${databaseGeneration}`);
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

if (!apply) {
  console.log(JSON.stringify({ ok: true, verified: source, generation: databaseGeneration, files: manifest.files?.length || 0 }));
  process.exit(0);
}

if (process.env.ALLOW_STATE_RESTORE !== '1') throw new Error('set ALLOW_STATE_RESTORE=1 after stopping the service to apply a restore');
const serviceName = process.env.SERVICE_NAME || 'codex-mobile-console';
const active = await run('/bin/systemctl', ['is-active', serviceName]).catch(() => 'inactive');
if (active.trim() === 'active' && process.env.ALLOW_LIVE_RESTORE !== '1') {
  throw new Error(`stop ${serviceName} before restoring, or set ALLOW_LIVE_RESTORE=1 only for controlled recovery`);
}

for (const file of manifest.files || []) {
  const destination = path.join(DATA_DIR, file.name);
  const temp = `${destination}.restore.tmp`;
  await copyFile(path.join(source, file.name), temp);
  await rename(temp, destination);
}
await rm(path.join(DATA_DIR, 'messages.sqlite3-wal'), { force: true });
await rm(path.join(DATA_DIR, 'messages.sqlite3-shm'), { force: true });
console.log(JSON.stringify({ ok: true, restored: source, dataDir: DATA_DIR, generation: databaseGeneration }));
