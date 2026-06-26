#!/usr/bin/env node
import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = process.env.ALI_OSS_ENV_FILE || path.join(ROOT, 'data', 'aliyun-oss.env');
const fileEnv = {};

if (existsSync(ENV_FILE)) {
  const rawEnv = await readFile(ENV_FILE, 'utf8');
  for (const line of rawEnv.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) fileEnv[key] = value;
  }
}

function env(name, fallback = '') {
  return String(process.env[name] || fileEnv[name] || fallback).trim();
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
  const cleanKey = key.replace(/^\/+/, '');
  return cleanKey ? `/${bucket}/${cleanKey}` : `/${bucket}/`;
}

function ossHost() {
  const bucket = env('ALI_OSS_BUCKET');
  const endpoint = env('ALI_OSS_ENDPOINT');
  if (!bucket || !endpoint) return '';
  return `${bucket}.${endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
}

function signedOssUrl(key) {
  const accessKeyId = env('ALI_OSS_ACCESS_KEY_ID');
  const accessKeySecret = env('ALI_OSS_ACCESS_KEY_SECRET');
  const bucket = env('ALI_OSS_BUCKET');
  const host = ossHost();
  if (!accessKeyId || !accessKeySecret || !bucket || !host) return '';
  const days = Math.max(1, Number(env('ALI_OSS_SIGNED_URL_DAYS', '3650')) || 3650);
  const expires = Math.floor(Date.now() / 1000) + days * 24 * 60 * 60;
  const resource = ossResource(bucket, key);
  const stringToSign = ['GET', '', '', String(expires), resource].join('\n');
  const signature = createHmac('sha1', accessKeySecret).update(stringToSign).digest('base64');
  const params = new URLSearchParams({
    OSSAccessKeyId: accessKeyId,
    Expires: String(expires),
    Signature: signature
  });
  return `https://${host}/${key}?${params.toString()}`;
}

async function ossRequest({ method, key = '', body = Buffer.alloc(0), contentType = '', headers = {} }) {
  const accessKeyId = env('ALI_OSS_ACCESS_KEY_ID');
  const accessKeySecret = env('ALI_OSS_ACCESS_KEY_SECRET');
  const bucket = env('ALI_OSS_BUCKET');
  const endpoint = env('ALI_OSS_ENDPOINT');
  if (!accessKeyId || !accessKeySecret || !bucket || !endpoint) return false;

  const host = `${bucket}.${endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  const date = new Date().toUTCString();
  const ossHeaders = Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => name.toLowerCase().startsWith('x-oss-'))
      .map(([name, value]) => [name.toLowerCase(), String(value).trim()])
      .sort(([left], [right]) => left.localeCompare(right))
  );
  const canonicalHeaders = Object.entries(ossHeaders)
    .map(([name, value]) => `${name}:${value}\n`)
    .join('');
  const resource = ossResource(bucket, key);
  const stringToSign = [method, '', contentType, date, `${canonicalHeaders}${resource}`].join('\n');
  const signature = createHmac('sha1', accessKeySecret).update(stringToSign).digest('base64');
  const target = key ? `https://${host}/${key}` : `https://${host}/`;
  const response = await fetch(target, {
    method,
    headers: {
      authorization: `OSS ${accessKeyId}:${signature}`,
      date,
      ...(contentType ? { 'content-type': contentType } : {}),
      'content-length': String(body.length),
      ...headers
    },
    body
  });
  return { ok: response.ok, status: response.status, text: await response.text() };
}

async function createBucketIfRequested() {
  if (env('ALI_OSS_DRY_RUN', '0') === '1') return false;
  if (env('ALI_OSS_AUTO_CREATE_BUCKET', '0') !== '1') return false;
  const result = await ossRequest({
    method: 'PUT',
    headers: { 'x-oss-acl': env('ALI_OSS_BUCKET_ACL', 'private') }
  });
  if (result.ok || result.status === 409) return true;
  throw new Error(`OSS bucket create failed ${result.status}: ${result.text}`);
}

async function putOssObject({ key, body, contentType }) {
  if (env('ALI_OSS_DRY_RUN', '0') === '1') return false;
  const objectAcl = env('ALI_OSS_OBJECT_ACL', '');
  const result = await ossRequest({
    method: 'PUT',
    key,
    body,
    contentType,
    headers: objectAcl ? { 'x-oss-object-acl': objectAcl } : {}
  });
  if (!result.ok) throw new Error(`OSS upload failed ${result.status}: ${result.text}`);
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
const useSignedUrls = env('ALI_OSS_SIGNED_URLS', '0') === '1';
const bundleKey = `${prefix}/${bundleName}`;
const manifestKey = `${prefix}/latest.json`;
const bundleUrl = useSignedUrls ? signedOssUrl(bundleKey) : publicBase ? joinUrl(publicBase, bundleKey) : '';
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

const bucketCreated = await createBucketIfRequested();
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
  manifestUrl: useSignedUrls ? signedOssUrl(manifestKey) : publicBase ? joinUrl(publicBase, manifestKey) : '',
  bucketCreated,
  uploaded: uploadedBundle && uploadedManifest
}, null, 2));
