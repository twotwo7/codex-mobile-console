# Contributing

Thanks for taking a look at Codex Mobile Console.

## Priorities

The project prioritizes:

- reliable Codex session control
- mobile usability
- simple frontend state management
- safe self-hosted deployment
- clear operational behavior

Avoid adding complex frontend behavior unless it directly improves the core chat/session workflow.

## Local Development

```bash
npm install
npm start
```

Run checks before sending changes:

```bash
node --check public/app.js
node --check server.js
node --check scripts/mobile-ui-check.mjs
git diff --check
npm run check:mobile-ui
```

## Code Style

- Keep frontend logic explicit and conservative.
- Prefer small modules over large hidden abstractions.
- Do not introduce dependencies unless they remove real complexity.
- Keep mobile layout compact and stable.
- Avoid expensive re-rendering of large message histories.

## Security

This project controls Codex processes on a server. Do not commit secrets, tokens, passwords, `data/`, `runtime/`, or local `.env` files.

Security-related issues should include:

- affected endpoint or UI flow
- reproduction steps
- expected impact
- suggested mitigation, if known
