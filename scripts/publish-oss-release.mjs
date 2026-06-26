#!/usr/bin/env node
import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: process.env.GIT_ASKPASS || '/bin/false'
      }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error([stdout, stderr].filter(Boolean).join('\n') || `${command} exited ${code}`));
    });
  });
}

function joinUrl(base, key) {
  return `${base.replace(/\/+$/, '')}/${key.replace(/^\/+/, '')}`;
}

function ossResource(bucket, key) {
  return `/${bucket}/${key.replace(/^\/+/, '')}`;
}

async function putOssObject({ key, body, contentType }) {
  const accessKeyId = env('ALI_OSS_ACCESS_KEY_ID');
  const accessKeySecret = env('ALI_OSS_ACCESS_KEY_SECRET');
  const bucket = env('ALI_OSS_BUCKET');
  const endpoint = env('ALI_OSS_ENDPOINT');
  if (!accessKeyId || !accessKeySecret || !bucket || !endpoint) return false;

  const host = `${bucket}.${endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  const date = new Date().toUTCString();
  const canonicalHeaders = 'x-oss-object-acl:public-read\n';
  const resource = ossResource(bucket, key);
  const stringToSign = ['PUT', '', contentType, date, `${canonicalHeaders}${resource}`].join('\n');
  const signature = createHmac('sha1', accessKeySecret).update(stringToSign).digest('base64');
  const response = await fetch(`https://${host}/${key}`, {
    method: 'PUT',
    headers: {
      authorization: `OSS ${accessKeyId}:${signature}`,
      date,
      'content-type': contentType,
      'content-length': String(body.length),
      'x-oss-object-acl': 'public-read'
    },
    body
  });
  if (!response.ok) throw new Error(`OSS upload failed ${response.status}: ${await response.text()}`);
  return true;
}

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const version = String(pkg.version || '').trim();
if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) {
  throw new Error(`invalid package version: ${version}`);
}

const tag = env('RELEASE_TAG', `v${version}`);
const commit = (await run('git', ['rev-parse', 'HEAD'])).stdout;
const releaseDir = path.join(ROOT, 'runtime', 'releases');
await mkdir(releaseDir, { recursive: true });

const bundleName = `codex-mobile-console-${tag}.bundle`;
const bundlePath = path.join(releaseDir, bundleName);
await run('git', ['bundle', 'create', bundlePath, '--all']);
const bundle = await readFile(bundlePath);
const bundleSha256 = createHash('sha256').update(bundle).digest('hex');

const prefix = env('ALI_OSS_PREFIX', 'codex-mobile-console/releases').replace(/^\/+|\/+$/g, '');
const publicBase = env('ALI_OSS_PUBLIC_BASE_URL');
const bundleKey = `${prefix}/${bundleName}`;
const manifestKey = `${prefix}/latest.json`;
const bundleUrl = publicBase ? joinUrl(publicBase, bundleKey) : '';
const manifest = {
  name: 'codex-mobile-console',
  version,
  tag,
  commit,
  bundleUrl,
  bundleSha256,
  publishedAt: new Date().toISOString()
};
const manifestBody = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(path.join(releaseDir, 'latest.json'), manifestBody);

const uploadedBundle = await putOssObject({
  key: bundleKey,
  body: bundle,
  contentType: 'application/octet-stream'
});
const uploadedManifest = await putOssObject({
  key: manifestKey,
  body: manifestBody,
  contentType: 'application/json; charset=utf-8'
});

console.log(JSON.stringify({
  version,
  tag,
  commit,
  bundlePath,
  bundleSha256,
  manifestPath: path.join(releaseDir, 'latest.json'),
  manifestUrl: publicBase ? joinUrl(publicBase, manifestKey) : '',
  uploaded: uploadedBundle && uploadedManifest
}, null, 2));
