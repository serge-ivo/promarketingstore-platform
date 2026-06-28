# Contributing

This repo is a Cloudflare-first TypeScript monorepo for ProMarketingStore.

## Local Checks

Run these before opening a pull request:

```bash
pnpm install
pnpm lint
pnpm build
pnpm typecheck
pnpm test
```

## Security Boundaries

- Do not commit Cloudflare, Meta, Google, or social account secrets.
- OAuth/page tokens must stay encrypted at rest.
- Backend-to-agent-brain calls must stay behind the service binding and `INTERNAL_TOKEN`.
- Publishing flows must require explicit approval unless a later autopilot policy says otherwise.

## Change Shape

- Keep Worker route files small and feature-focused.
- Add tests around ownership, OAuth state, token encryption, approval gates, and provider adapter behavior.
- Update `README.md`, `.env.example`, and `CHANGELOG.md` when configuration or operator behavior changes.
