# Codex Mobile Console

Self-hosted AI operations hub for Codex sessions, long-running expert secretary workflows, server health, audit, upgrades, and recovery.

Codex Mobile Console keeps execution and operational data on your own server, VPS, NAS, home lab, or remote development box. Its browser UI gives you one control surface for AI work and the machine that runs it.

![Codex Mobile Console use case](docs/assets/case-remote-control.svg)

## What It Is

Official Codex clients already cover rich coding workflows across desktop, web, cloud, and mobile. This project focuses on a different boundary: operating your own always-on AI runtime.

It is not a generic AI chat UI and not a mobile SSH replacement. It is a private operations layer for people who want to:

- run a persistent expert secretary with scheduled, auditable work
- see server health, storage, versions, sessions, and queued work together
- operate multiple Codex projects without keeping a terminal connected
- stop stuck commands, inspect process state, and recover after restarts
- back up local state and perform safe console or Codex upgrades
- use phone, tablet, or desktop as a secure window into the same private runtime

The default workflow is:

- keep Codex sessions and the secretary alive on the server
- open the **AI Ops Hub** for server resources, tasks, projects, audit, and recovery
- enter a specialist panel only when deeper action is required
- keep every operation protected by local authentication, audit, and a total stop switch

## Use Cases

| Remote control | Prompt queue | Runtime diagnostics |
| --- | --- | --- |
| ![Remote Codex control](docs/assets/case-remote-control.svg) | ![Codex prompt queue](docs/assets/case-queue.svg) | ![Codex runtime diagnostics](docs/assets/case-runtime.svg) |

## Highlights

- Unified AI Ops Hub for server health, secretary tasks, projects, audit, and recovery
- Persistent expert secretary with daily planning, continuation, learning, and review cycles
- Mobile-first web UI for Codex sessions
- Persistent server-side sessions; terminal disconnects do not stop Codex
- Recent, flat, directory-grouped, and trash session views
- Global Codex history discovery from `~/.codex/sessions`
- Saved Codex JSONL context rendering
- Message folding for tool output, code, and long messages
- Queue support for prompts sent while Codex is running
- Top-level run state indicator and stop control
- Runtime panel with Codex process, browser cache, and service status
- Image upload for multimodal prompts
- Skill manager backed by async local scanning
- PWA service worker cache for phone usage
- 30-day login cookie for trusted personal devices
- Safe restart flow that waits for active Codex child processes
- Backup, restore, application update, rollback, and Codex upgrade workflows

## Feature Tour

| Skill management | Chat | Sessions |
| --- | --- | --- |
| ![Skill management](docs/assets/case-skills.svg) | ![Chat](docs/assets/mobile-chat.png) | ![Sessions](docs/assets/mobile-sessions.png) |

## Quick Start

Prerequisites:

- Linux server with Node.js 20+
- Codex CLI installed and authenticated on the server
- A project directory such as `$HOME/Projects`

One-command install on a Linux server:

```bash
curl -fsSL https://welcome.ai.hehao.pro/install.sh | bash
```

This installs the latest release bundle from the OSS release channel, stores the app under `/opt/codex-mobile-console`, creates a systemd service, starts it on `127.0.0.1:7072`, configures the OSS update source, and prints the generated admin password.

The service runs as the user who executed the installer, so Codex should already be authenticated for that user.

Optional domain and HTTPS setup:

```bash
curl -fsSL https://welcome.ai.hehao.pro/install.sh | DOMAIN=codex.example.com SETUP_CADDY=1 bash
```

Point the domain A record to the server first. With `DOMAIN` set, the installer installs/enables Caddy when needed and writes a reverse proxy from `https://codex.example.com` to `127.0.0.1:7072`.

Optional bare public-IP setup:

```bash
curl -fsSL https://welcome.ai.hehao.pro/install.sh | PUBLIC_BIND=1 bash
```

This binds the app directly to `0.0.0.0:7072`. Use firewall/security group rules if you choose this mode.

Clone and run:

```bash
git clone https://github.com/twotwo7/codex-mobile-console.git
cd codex-mobile-console
npm install
COOKIE_SECURE=0 npm start
```

The server listens on `127.0.0.1:7072` by default.

On first start, an admin password is generated at:

```bash
cat data/admin-password.txt
```

For production-style local service setup:

```bash
sudo ./scripts/install-systemd.sh
sudo systemctl enable --now codex-mobile-console
```

Then put it behind HTTPS before exposing it to the internet. See [Deployment](docs/deployment.md).

## Configuration

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind host |
| `PORT` | `7072` | Bind port |
| `DATA_DIR` | `./data` | State, password, uploads, registry data |
| `CODEX_HOME` | `/root/.codex` | Codex home directory |
| `CODEX_BIN` | `/usr/bin/codex` | Codex executable |
| `CODEX_NODE` | current Node executable | Node runtime when `CODEX_BIN` is a `.js` file |
| `PROJECTS_ROOT` | `/root/Projects` | Default project browser root |
| `SKILL_ROOTS` | `$CODEX_HOME/skills,/root/.agents/skills` | Skill scan roots |
| `APP_UPDATE_MANIFEST_URL` | unset | Preferred update manifest URL, such as an Aliyun OSS `latest.json` |
| `COOKIE_SECURE=0` | unset | Disable Secure cookies for non-HTTPS local testing |

## Aliyun OSS Install And Update Source

The recommended public installer uses the OSS release channel:

```bash
curl -fsSL https://welcome.ai.hehao.pro/install.sh | bash
```

New installs are configured with the OSS update manifest, so app update checks use OSS by default. Users can disable automatic updates in the console settings.

GitHub stays as the upstream repository while production servers can check a domestic OSS release manifest first.

Publish a release bundle:

```bash
ALI_OSS_ACCESS_KEY_ID=... \
ALI_OSS_ACCESS_KEY_SECRET=... \
ALI_OSS_BUCKET=your-bucket \
ALI_OSS_ENDPOINT=oss-cn-hangzhou.aliyuncs.com \
ALI_OSS_PREFIX=codex-mobile-console/releases \
ALI_OSS_PUBLIC_BASE_URL=https://your-bucket.oss-cn-hangzhou.aliyuncs.com \
npm run release:oss
```

Configure deployed services to prefer the OSS manifest:

```bash
APP_UPDATE_MANIFEST_URL=https://your-bucket.oss-cn-hangzhou.aliyuncs.com/codex-mobile-console/releases/latest.json
```

The updater downloads a Git bundle from OSS, verifies sha256, fetches the release tag locally, then checks out that tag. GitHub remains the fallback source when no manifest URL is configured.

## Security Model

This app can start Codex processes and optionally run them with elevated permissions. Treat it as a private server control surface.

Recommended:

- expose only through HTTPS
- use a strong admin password
- keep it behind your own trusted domain, VPN, or access gateway
- do not commit `data/`, `runtime/`, `.env`, or token files
- do not expose it as a public demo with real server access

The login cookie lasts 30 days so your own phone does not need frequent logins.

## Documentation

- [State storage, backup, and recovery](docs/state-storage.md)

- [Deployment](docs/deployment.md)
- [Promotion plan](docs/promotion.md)
- [Roadmap](docs/roadmap.md)
- [Contributing](CONTRIBUTING.md)

## Project Status

This is a personal self-hosted tool that has reached a usable v1.x shape. The core chat/session workflow is the priority. The project intentionally favors reliability and mobile usability over complex frontend automation.

## License

MIT
