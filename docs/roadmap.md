# Roadmap

This roadmap is intentionally pragmatic. The core workflow is personal, self-hosted Codex control from mobile.

## Near Term

- One-command installer for clean Linux servers
- Docker Compose option
- Better first-run setup page
- Built-in update check and guided update flow
- More runtime diagnostics when Codex status looks stale
- Export/import local app state

## Reliability

- More automated browser tests around session state transitions
- Explicit tests for running, stopping, queued, completed, and recovered states
- Better service worker update prompts
- Safer handling of large Codex JSONL histories

## Mobile UX

- More compact dense mode
- Better screenshots/image message presentation
- Optional notification integration through browser/PWA capabilities
- More reliable resume after mobile browser backgrounding

## Codex Integration

- More faithful rendering of native Codex history
- Skill usage helpers without blocking chat startup
- Session fork verification across Codex CLI versions
- Context/token usage visibility when available in Codex history

## Deployment

- Domain and HTTPS guided setup
- Tailscale / Cloudflare Access deployment recipes
- Backup and restore guide
- Release notes and upgrade playbooks

## Not Planned Yet

- Public hosted SaaS
- Multi-tenant team mode
- Arbitrary remote shell replacement
- Replacing VS Code or local IDE workflows
