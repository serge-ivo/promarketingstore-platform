# Security Policy

Report vulnerabilities privately to the repository owner before opening a public issue.

Do not include live OAuth tokens, Cloudflare secrets, D1 exports, or customer campaign data in bug reports. Include the affected route, package, reproduction steps, and expected impact.

Security-sensitive areas:

- OAuth callback and social token storage in `packages/backend/src/social.ts`.
- Session signing and auth middleware in `packages/backend/src/auth.ts`.
- Backend-to-agent-brain internal calls in `packages/backend/src/brain.ts`.
- Durable Object authorization in `packages/agent-brain/src/index.ts`.
