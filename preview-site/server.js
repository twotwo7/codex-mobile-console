import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROJECT_DIR = path.resolve(__dirname, '..');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 7372);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function normalizeRequestPath(url) {
  let pathname = url.pathname;
  const siteMatch = pathname.match(/^\/sites\/[^/]+(\/.*)?$/);
  if (siteMatch) pathname = siteMatch[1] || '/';
  if (pathname === '/') return '/index.html';
  return pathname;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function parseEnvValue(raw = '') {
  let value = String(raw || '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value;
}

async function readEnvFileValue(file, name) {
  const text = await readFile(file, 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    if (key === name) return parseEnvValue(trimmed.slice(index + 1));
  }
  return '';
}

async function installerManifestUrl() {
  if (process.env.OSS_INSTALL_MANIFEST_URL) return process.env.OSS_INSTALL_MANIFEST_URL;
  if (process.env.APP_UPDATE_MANIFEST_URL) return process.env.APP_UPDATE_MANIFEST_URL;
  const files = [
    process.env.APP_UPDATE_ENV_FILE || path.join(PROJECT_DIR, 'data', 'app-update.env'),
    process.env.ALI_OSS_ENV_FILE || path.join(PROJECT_DIR, 'data', 'aliyun-oss.env')
  ];
  for (const file of files) {
    const value = await readEnvFileValue(file, 'APP_UPDATE_MANIFEST_URL');
    if (value) return value;
  }
  return '';
}

function installScript(manifestUrl) {
  return `#!/usr/bin/env bash
set -euo pipefail

MANIFEST_URL=${shellQuote(manifestUrl)}
REPO_URL="\${REPO_URL:-https://github.com/twotwo7/codex-mobile-console.git}"
INSTALL_DIR="\${INSTALL_DIR:-/opt/codex-mobile-console}"
SERVICE_NAME="\${SERVICE_NAME:-codex-mobile-console}"
HOST="\${HOST:-127.0.0.1}"
PORT="\${PORT:-7072}"
CODEX_BIN="\${CODEX_BIN:-$(command -v codex || true)}"
NODE_BIN="\${NODE_BIN:-$(command -v node || true)}"
SUDO_BIN=""
INSTALL_USER="$(id -un)"
INSTALL_GROUP="$(id -gn)"
INSTALL_HOME="\${HOME:-$(getent passwd "$INSTALL_USER" | cut -d: -f6)}"
CODEX_HOME="\${CODEX_HOME:-$INSTALL_HOME/.codex}"
PROJECTS_ROOT="\${PROJECTS_ROOT:-$INSTALL_HOME/Projects}"

log() { printf '[codex-mobile-console] %s\\n' "$*"; }
fail() { printf '[codex-mobile-console] error: %s\\n' "$*" >&2; exit 1; }
need_command() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required."; }

if [[ "$(uname -s)" != "Linux" ]]; then
  fail "this installer currently supports Linux servers only."
fi

if [[ "$(id -u)" != "0" ]]; then
  need_command sudo
  SUDO_BIN="sudo"
else
  INSTALL_USER="root"
  INSTALL_GROUP="root"
  INSTALL_HOME="/root"
  CODEX_HOME="\${CODEX_HOME:-/root/.codex}"
  PROJECTS_ROOT="\${PROJECTS_ROOT:-/root/Projects}"
fi

need_command curl
need_command git
need_command npm
need_command systemctl
need_command sha256sum
[[ -n "$NODE_BIN" ]] || fail "node was not found. Install Node.js 20+ first."

NODE_MAJOR="$("$NODE_BIN" -e "console.log(Number(process.versions.node.split('.')[0]))")"
if (( NODE_MAJOR < 20 )); then
  fail "Node.js 20+ is required. Current: $("$NODE_BIN" --version)"
fi

if [[ -z "$CODEX_BIN" ]]; then
  fail "codex was not found in PATH. Install and authenticate Codex CLI first, or rerun with CODEX_BIN=/path/to/codex."
fi

if [[ ! -x "$CODEX_BIN" ]]; then
  fail "CODEX_BIN is not executable: $CODEX_BIN"
fi

tmp_dir="$(mktemp -d)"
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT

manifest_file="$tmp_dir/latest.json"
bundle_file="$tmp_dir/release.bundle"

log "reading OSS release manifest"
curl -fsSL "$MANIFEST_URL" -o "$manifest_file"

read_manifest() {
  "$NODE_BIN" -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const field=process.argv[2]; process.stdout.write(String(m[field] || ''));" "$manifest_file" "$1"
}

tag="$(read_manifest tag)"
bundle_url="$(read_manifest bundleUrl)"
bundle_sha="$(read_manifest bundleSha256)"
version="$(read_manifest version)"

[[ "$tag" =~ ^v?[0-9]+\\.[0-9]+\\.[0-9]+([-+][A-Za-z0-9._-]+)?$ ]] || fail "invalid release tag in OSS manifest: $tag"
[[ -n "$bundle_url" ]] || fail "missing bundleUrl in OSS manifest."
[[ "$bundle_sha" =~ ^[a-f0-9]{64}$ ]] || fail "invalid bundle sha256 in OSS manifest."

log "downloading OSS release bundle: $tag"
curl -fsSL "$bundle_url" -o "$bundle_file"
printf '%s  %s\\n' "$bundle_sha" "$bundle_file" | sha256sum -c -
git bundle verify "$bundle_file" >/dev/null

log "install directory: $INSTALL_DIR"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  log "updating existing installation from OSS bundle"
  if [[ -n "$SUDO_BIN" ]]; then
    $SUDO_BIN chown -R "$(id -u):$(id -g)" "$INSTALL_DIR"
  fi
  if [[ -n "$(git -C "$INSTALL_DIR" status --short)" ]]; then
    fail "install directory has uncommitted changes: $INSTALL_DIR"
  fi
  git -C "$INSTALL_DIR" fetch --force "$bundle_file" "+refs/tags/$tag:refs/tags/$tag"
  git -C "$INSTALL_DIR" checkout --force "$tag"
else
  log "installing from OSS bundle"
  $SUDO_BIN mkdir -p "$(dirname "$INSTALL_DIR")"
  worktree="$tmp_dir/app"
  git init "$worktree" >/dev/null
  git -C "$worktree" fetch --force "$bundle_file" "+refs/tags/$tag:refs/tags/$tag"
  git -C "$worktree" checkout --force "$tag"
  git -C "$worktree" remote add origin "$REPO_URL" 2>/dev/null || true
  $SUDO_BIN rm -rf "$INSTALL_DIR"
  $SUDO_BIN mv "$worktree" "$INSTALL_DIR"
  if [[ -n "$SUDO_BIN" ]]; then
    $SUDO_BIN chown -R "$(id -u):$(id -g)" "$INSTALL_DIR"
  fi
fi

log "installing npm dependencies"
cd "$INSTALL_DIR"
npm install --omit=optional
mkdir -p "$PROJECTS_ROOT"

log "installing systemd service"
$SUDO_BIN env \\
  SERVICE_NAME="$SERVICE_NAME" \\
  NODE_BIN="$NODE_BIN" \\
  HOST="$HOST" \\
  PORT="$PORT" \\
  CODEX_BIN="$CODEX_BIN" \\
  CODEX_HOME="$CODEX_HOME" \\
  PROJECTS_ROOT="$PROJECTS_ROOT" \\
  SERVICE_USER="$INSTALL_USER" \\
  SERVICE_GROUP="$INSTALL_GROUP" \\
  SERVICE_HOME="$INSTALL_HOME" \\
  "$INSTALL_DIR/scripts/install-systemd.sh"

log "configuring OSS update source"
$SUDO_BIN mkdir -p "$INSTALL_DIR/data" "/etc/systemd/system/$SERVICE_NAME.service.d"
escaped_manifest="$(printf '%s' "$MANIFEST_URL" | sed 's/[\\\\"]/\\\\&/g')"
printf 'APP_UPDATE_MANIFEST_URL="%s"\\n' "$escaped_manifest" | $SUDO_BIN tee "$INSTALL_DIR/data/app-update.env" >/dev/null
$SUDO_BIN chmod 600 "$INSTALL_DIR/data/app-update.env"
cat <<UNIT | $SUDO_BIN tee "/etc/systemd/system/$SERVICE_NAME.service.d/20-app-update.conf" >/dev/null
[Service]
EnvironmentFile=$INSTALL_DIR/data/app-update.env
UNIT
$SUDO_BIN systemctl daemon-reload

log "starting service"
$SUDO_BIN systemctl enable --now "$SERVICE_NAME"

log "health check"
for _ in 1 2 3 4 5; do
  if curl -fsS "http://127.0.0.1:$PORT/api/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/api/healthz" >/dev/null \\
  || fail "service did not pass health check. Run: systemctl status $SERVICE_NAME --no-pager"

PASSWORD_FILE="$INSTALL_DIR/data/admin-password.txt"
log "installed successfully from OSS"
printf '\\nVersion: %s\\n' "\${version:-$tag}"
printf 'Local URL: http://127.0.0.1:%s\\n' "$PORT"
printf 'Password: %s\\n' "$($SUDO_BIN tr -d '\\r\\n' < "$PASSWORD_FILE")"
cat <<MSG

Next steps:
1. Put the app behind HTTPS before phone access.
2. Keep HOST=127.0.0.1 when using a reverse proxy.
3. Future app updates use the OSS manifest by default.
4. Make sure Codex is authenticated for service user: $INSTALL_USER

Useful commands:
  systemctl status $SERVICE_NAME --no-pager
  journalctl -u $SERVICE_NAME -f
  $INSTALL_DIR/scripts/safe-restart.sh
MSG
`;
}

async function sendInstaller(req, res) {
  const manifestUrl = await installerManifestUrl();
  if (!manifestUrl) {
    res.writeHead(503, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store'
    });
    res.end('OSS install manifest is not configured on this server.\n');
    return;
  }
  const body = installScript(manifestUrl);
  res.writeHead(200, {
    'content-type': 'text/x-shellscript; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

async function sendFile(res, requestPath) {
  let safePath = decodeURIComponent(requestPath);
  safePath = path.normalize(safePath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(PUBLIC_DIR, safePath);
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  try {
    const info = await stat(fullPath);
    const target = info.isDirectory() ? path.join(fullPath, 'index.html') : fullPath;
    const ext = path.extname(target).toLowerCase();
    const cacheControl = ext === '.html' ? 'no-store' : 'public, max-age=3600';
    res.writeHead(200, {
      'content-type': TYPES[ext] || 'application/octet-stream',
      'cache-control': cacheControl,
      'x-content-type-options': 'nosniff'
    });
    createReadStream(target).pipe(res);
  } catch {
    const index = path.join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, {
      'content-type': TYPES['.html'],
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    });
    createReadStream(index).pipe(res);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (url.pathname.match(/^\/sites\/[^/]+$/)) {
    res.writeHead(302, { location: `${url.pathname}/${url.search || ''}` });
    res.end();
    return;
  }
  if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }
  const requestPath = normalizeRequestPath(url);
  const response = requestPath === '/install.sh'
    ? sendInstaller(req, res)
    : sendFile(res, requestPath);
  response.catch((error) => {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(error.message || 'Internal Server Error');
  });
});

server.listen(PORT, HOST, () => {
  console.log(`codex-mobile-console preview listening on http://${HOST}:${PORT}`);
});
