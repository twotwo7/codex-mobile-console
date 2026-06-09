# Security Policy

Codex Mobile Console is intended for personal self-hosted use. It can start Codex processes and expose server-side project files through Codex workflows, so treat it as a private control surface.

## Supported Versions

Security fixes are expected to target the current `main` branch and latest tagged release.

## Reporting Issues

If you find a security issue, please avoid posting public exploit details first. Open a GitHub issue with a minimal description and request a private disclosure channel, or contact the maintainer through the GitHub profile.

Useful details:

- affected endpoint or UI flow
- whether authentication is required
- reproduction steps
- expected impact
- suggested mitigation, if known

## Deployment Recommendations

- Put the app behind HTTPS.
- Keep `HOST=127.0.0.1` when using a reverse proxy.
- Use a strong admin password.
- Keep `data/`, `runtime/`, `.env`, and token files out of git.
- Consider VPN, Tailscale, Cloudflare Access, or another trusted access layer.
- Do not expose a public demo connected to a real server account.
