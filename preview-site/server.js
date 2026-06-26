import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
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
  sendFile(res, normalizeRequestPath(url)).catch((error) => {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(error.message || 'Internal Server Error');
  });
});

server.listen(PORT, HOST, () => {
  console.log(`codex-mobile-console preview listening on http://${HOST}:${PORT}`);
});
