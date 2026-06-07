# Codex Mobile Console

Mobile-first web console for controlling local Codex sessions from a phone.

## Features

- 30-day login cookie for trusted devices
- Mobile session switcher with recent, flat, and directory grouped views
- Global Codex session discovery from `~/.codex/sessions`
- Saved Codex context rendering from Codex JSONL history
- Automatic polling for external Codex context updates
- Message folding for tool output, code, and long messages
- Session rename and deletion
- Directory browser for new sessions
- Optional global elevated execution mode
- PWA-style service worker cache

## Run

```bash
npm start
```

The server defaults to `127.0.0.1:7072`.

## Configuration

Environment variables:

- `HOST`: bind host, default `127.0.0.1`
- `PORT`: bind port, default `7072`
- `DATA_DIR`: state and password directory, default `./data`
- `CODEX_HOME`: Codex home directory, default `/root/.codex`
- `CODEX_BIN`: Codex executable, default `/root/.nvm/versions/node/v22.22.0/bin/codex`
- `COOKIE_SECURE=0`: disable Secure cookie flag for non-HTTPS local testing

## Security Notes

Do not commit `data/`; it contains the admin password and local session state.

This app can start Codex with elevated permissions when enabled in settings. Expose it only behind trusted HTTPS access control.
