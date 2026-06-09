# Deployment

This guide covers a practical self-hosted setup for Codex Mobile Console.

## 1. Install Prerequisites

Install Node.js 20+ and Codex CLI on the server.

Verify:

```bash
node --version
codex --version
codex doctor
```

Make sure Codex is already authenticated and works from the same user that will run the service.

## 2. One-Command Install

For a fresh Linux server:

```bash
curl -fsSL https://raw.githubusercontent.com/twotwo7/codex-mobile-console/main/scripts/install.sh | bash
```

Defaults:

| Setting | Value |
| --- | --- |
| Install directory | `/opt/codex-mobile-console` |
| Service | `codex-mobile-console` |
| Host | `127.0.0.1` |
| Port | `7072` |
| Project browser root | `$HOME/Projects` |

Override values:

```bash
curl -fsSL https://raw.githubusercontent.com/twotwo7/codex-mobile-console/main/scripts/install.sh | \
  INSTALL_DIR=/srv/codex-mobile-console \
  PORT=7072 \
  PROJECTS_ROOT=/root/Projects \
  bash
```

The installer prints the local URL and generated password after startup.

The systemd service runs as the user who executed the installer. This is important because Codex authentication usually lives under that user's home directory. Defaults derived from the install user:

| Setting | Example |
| --- | --- |
| `HOME` | `/root` or `/home/alice` |
| `CODEX_HOME` | `$HOME/.codex` |
| `PROJECTS_ROOT` | `$HOME/Projects` |

If Codex is authenticated as a different user, either run the installer as that user or pass explicit values:

```bash
curl -fsSL https://raw.githubusercontent.com/twotwo7/codex-mobile-console/main/scripts/install.sh | \
  CODEX_HOME=/root/.codex \
  PROJECTS_ROOT=/root/Projects \
  bash
```

## 3. Clone And Run Locally

```bash
git clone https://github.com/twotwo7/codex-mobile-console.git
cd codex-mobile-console
npm install
COOKIE_SECURE=0 npm start
```

The app defaults to:

```text
http://127.0.0.1:7072
```

The first generated password is stored in:

```bash
cat data/admin-password.txt
```

Change it by editing that file and restarting the service.

`COOKIE_SECURE=0` is only for local HTTP testing. Keep the default Secure cookie behavior when serving through HTTPS.

## 4. Install As A systemd Service

From the project root:

```bash
sudo ./scripts/install-systemd.sh
sudo systemctl enable --now codex-mobile-console
sudo systemctl status codex-mobile-console --no-pager
```

Override values when needed:

```bash
sudo SERVICE_NAME=codex-mobile-console \
  HOST=127.0.0.1 \
  PORT=7072 \
  CODEX_BIN=/usr/bin/codex \
  CODEX_HOME=/root/.codex \
  PROJECTS_ROOT=/root/Projects \
  SERVICE_USER=root \
  SERVICE_GROUP=root \
  SERVICE_HOME=/root \
  ./scripts/install-systemd.sh
```

The service intentionally binds to `127.0.0.1` by default. Use a reverse proxy for public access.

## 5. Configure HTTPS With Caddy

Caddy is the simplest option when the domain already points at the server.

Example `/etc/caddy/Caddyfile`:

```caddyfile
codex.example.com {
  reverse_proxy 127.0.0.1:7072
}
```

Reload:

```bash
sudo systemctl reload caddy
```

Then open:

```text
https://codex.example.com
```

## 6. Configure HTTPS With Nginx

Example Nginx server block:

```nginx
server {
    listen 80;
    server_name codex.example.com;

    location / {
        proxy_pass http://127.0.0.1:7072;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then use Certbot or your existing certificate workflow to enable HTTPS.

## 7. Safe Restart

The app can have active Codex child processes. Prefer safe restart:

```bash
./scripts/safe-restart.sh
```

If Codex is running, the API may queue the restart instead of hard killing the active process.

For system-level waiting:

```bash
./scripts/queue-safe-restart.sh
```

Logs:

```bash
tail -f runtime/safe-restart.log
```

## 8. Health Check

```bash
curl -fsS http://127.0.0.1:7072/api/healthz
```

Expected:

```json
{"ok":true}
```

## 9. Security Checklist

- Use HTTPS for phone access.
- Keep `HOST=127.0.0.1` when using a reverse proxy.
- Store the admin password in `data/admin-password.txt` with mode `0600`.
- Do not commit `data/`, `runtime/`, `.env`, or token files.
- Avoid exposing this app on an untrusted public network.
- Consider adding VPN, Cloudflare Access, Tailscale, or another access layer.
