import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const BACKUP_ROOT = path.resolve(process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups'));
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP || 30));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(BACKUP_ROOT, stamp);

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

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function fileEntry(file) {
  const body = await readFile(file);
  return {
    name: path.basename(file),
    bytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex')
  };
}

const database = path.join(DATA_DIR, 'messages.sqlite3');
let copied = [];
for (let attempt = 1; attempt <= 3; attempt += 1) {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true, mode: 0o700 });
  copied = [];
  for (const name of ['state.json', 'skill-registry.json', 'admin-password.txt', 'app-update.env']) {
    const source = path.join(DATA_DIR, name);
    if (!(await exists(source))) continue;
    const destination = path.join(target, name);
    await copyFile(source, destination);
    copied.push(destination);
  }
  if (!(await exists(database))) break;
  const destination = path.join(target, 'messages.sqlite3');
  await run('/bin/sqlite3', [database, `.backup '${destination.replaceAll("'", "''")}'`]);
  const integrity = (await run('/bin/sqlite3', [destination, 'PRAGMA integrity_check;'])).trim();
  if (integrity !== 'ok') throw new Error(`backup sqlite integrity check failed: ${integrity}`);
  copied.push(destination);
  const stateGeneration = Number(JSON.parse(await readFile(path.join(target, 'state.json'), 'utf8')).storageGeneration || 0);
  const databaseGeneration = Number((await run('/bin/sqlite3', [destination, "SELECT COALESCE((SELECT value FROM schema_info WHERE key='state_generation'), '0');"])).trim() || 0);
  if (stateGeneration === databaseGeneration) break;
  if (attempt === 3) throw new Error(`backup generation mismatch after ${attempt} attempts: state=${stateGeneration} sqlite=${databaseGeneration}`);
}

const stateFile = path.join(target, 'state.json');
if (await exists(stateFile)) JSON.parse(await readFile(stateFile, 'utf8'));
const manifest = {
  version: 1,
  createdAt: new Date().toISOString(),
  source: DATA_DIR,
  files: await Promise.all(copied.map(fileEntry))
};
await writeFile(path.join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

const backups = (await readdir(BACKUP_ROOT, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .reverse();
for (const expired of backups.slice(KEEP)) await rm(path.join(BACKUP_ROOT, expired), { recursive: true, force: true });

console.log(JSON.stringify({ ok: true, backup: target, files: manifest.files, retained: Math.min(backups.length, KEEP) }));
