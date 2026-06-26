#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : fallback;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: process.env.GIT_ASKPASS || '/bin/false',
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error([stdout, stderr].filter(Boolean).join('\n') || `${command} exited ${code}`));
    });
  });
}

async function download(url, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

const url = argValue('--url');
const sha256 = argValue('--sha256').toLowerCase();
const tag = argValue('--tag');
const root = path.resolve(argValue('--root', process.cwd()));

if (!url) fail('missing --url');
if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) fail('missing or invalid --sha256');
if (!tag || !/^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(tag)) fail('missing or invalid --tag');

const updateDir = path.join(root, 'runtime', 'app-updates');
await mkdir(updateDir, { recursive: true });
const bundlePath = path.join(updateDir, `${tag}.bundle`);

const body = await download(url);
const actual = createHash('sha256').update(body).digest('hex');
if (actual !== sha256) fail(`sha256 mismatch: expected ${sha256}, got ${actual}`);
await writeFile(bundlePath, body, { mode: 0o600 });

await run('git', ['bundle', 'verify', bundlePath], { cwd: root });
await run('git', ['fetch', '--force', bundlePath, `refs/tags/${tag}:refs/tags/${tag}`], { cwd: root });
await run('git', ['checkout', tag], { cwd: root });
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
console.log(`updated to ${tag} (${pkg.version || 'unknown'})`);
