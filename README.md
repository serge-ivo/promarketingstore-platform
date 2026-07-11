# ProMarketingStore

**promarketingstore.online** — AI-powered marketing automation. Autonomous campaign execution, content distribution, analytics — all from a prompt.

## What it is

ProMarketingStore is the paid tier of FreeMarketingStore. While FreeMarketingStore gives you planning tools (calendars, generators, SEO), ProMarketingStore EXECUTES:

1. **AI Campaign Agent** — describe your goal, AI plans AND runs the campaign
2. **Social Media Autopilot** — generates content, schedules, posts to X/LinkedIn/Instagram/TikTok
3. **Creator Marketplace** — hire marketers for campaigns, or offer your services
4. **Prompt Campaign Services** — "Launch my SaaS in 30 days" → full campaign planned and executed
5. **Analytics Dashboard** — real-time metrics across all channels, AI-powered insights

## Boundary with FreeMarketingStore

FreeMarketingStore can have free sign-in. The boundary is not accounts vs no accounts; it is diagnostics vs execution.

- **FMS** stores free marketing intelligence: saved sites, audits, Search Console setup, readiness scores, and issue prompts.
- **PMS** runs paid marketing execution: campaign agents, connected social accounts, scheduled publishing, email sending, analytics, optimization, and marketplace services.

PMS should consume FMS readiness data when starting a campaign, but it should not duplicate FMS as a toolbox.

See [docs/product-boundary.md](docs/product-boundary.md).

## Architecture (follows PAS pattern)

```
pms/platform/
├── packages/
│   ├── backend/       Hono API Worker control plane
│   ├── agent-brain/   internal Durable Object Worker for campaign memory/state
│   └── social/        provider adapters for organic publishing
├── store/             Store site (promarketingstore.online)
├── schema.sql         D1 schema for users, campaigns, posts, accounts, metrics
└── PLAN-AGENTIC-CAMPAIGN-BRAIN.md
```

## Install

Requirements:

- Node.js 22+
- pnpm 10+
- Cloudflare Wrangler 4+

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

## Local Usage

Run the API Worker:

```bash
cd packages/backend
pnpm dev
```

Run the internal campaign brain Worker in another terminal:

```bash
cd packages/agent-brain
pnpm dev
```

Apply D1 migrations before using real campaign data:

```bash
cd packages/backend
pnpm db:migrate:local
```

## Required Configuration

The backend Worker expects these Cloudflare bindings and secrets:

- `DB`: D1 database binding.
- `AGENT_BRAIN`: service binding to `promarketingstore-agent-brain`.
- `SESSION_SIGNING_KEY`: signs local PMS sessions.
- `INTERNAL_TOKEN`: shared backend-to-agent-brain service token.
- `SOCIAL_TOKEN_ENCRYPTION_KEY`: encrypts OAuth/page tokens at rest.
- `META_APP_ID`, `META_APP_SECRET`: Meta app credentials.
- `META_REDIRECT_URI`: public OAuth callback URL, optional when `CORS_ORIGIN` is correct.
- `META_GRAPH_VERSION`: optional, defaults to `v25.0`.

The current publish MVP supports connected Facebook Pages for approved text/link posts. Instagram account discovery is wired through Meta OAuth; Instagram publishing needs the media pipeline to provide public image URLs.

## Agent Team (Marketing-specific)

| Agent | Role |
|-------|------|
| **PO** (Marketing Director) | Chats with client, understands goals, defines campaign strategy |
| **Strategist** | Plans campaign: channels, timeline, budget, content themes |
| **Content Creator** | Writes posts, emails, blog outlines, ad copy (platform-specific) |
| **Scheduler** | Picks optimal times, queues posts, manages publishing calendar |
| **Analytics** | Tracks metrics, generates reports, suggests optimizations |

## Marketplace Model

- **Creators** list services: campaign management, content writing, SEO, social media management
- **Pricing**: creators set prices (minimum $10, platform takes 10%)
- **AI-assisted**: creators use AI agents to scale their services (1 person manages 10 clients)
- **Packages**: Fixed-price packages (e.g., "30-day launch campaign — $299")
- **Subscription**: $9/mo platform access (AI agent + scheduling + marketplace)

## Services offered on marketplace

| Service | AI-generated | Human-managed | Price range |
|---------|-------------|---------------|-------------|
| Content calendar (30 days) | Instant | 1 day review | $25-100 |
| Social media management (mo) | AI autopilot | Human oversight | $99-500/mo |
| Campaign strategy | Draft in 2min | 1-2 day refinement | $50-200 |
| SEO content pack (10 posts) | AI draft | Human edit | $100-400 |
| Email sequence (5 emails) | Instant | 1 day polish | $50-150 |
| Full launch campaign | AI plan + execute | Human oversight | $299-999 |
| Prompt campaigns | Instant | N/A (AI only) | $0 (included in sub) |

## Pro features (vs Free)

| Feature | Free | Pro ($9/mo) |
|---------|------|-------------|
| Content calendar | Visual planner | Auto-filled + scheduled |
| Post generation | Template-based | AI (GPT-4o via platform) |
| Social posting | Planning only | **Actually posts** (X, LinkedIn, IG, TikTok) |
| Email sending | Sequence builder | **Actually sends** (Mailgun/SES) |
| SEO tools | Keyword planner | Full audit + tracking + rank monitoring |
| Analytics | N/A | Multi-channel dashboard |
| A/B testing | Calculator only | **Live tests** (hosts variants, tracks results) |
| AI campaign agent | N/A | "Run my launch" → autonomous execution |
| Marketplace | N/A | Hire marketers + offer services |
| Domain finder | Heuristic check | Registrar API (real availability) |
| Scheduling | Manual export | Cron-based auto-posting |

## Autonomous Campaign Flow

```
User: "Launch my SaaS product targeting indie hackers"
  ↓
PO Agent: Plans 30-day campaign → tickets
  ↓
Strategist: Channels (X + LinkedIn + HN + Reddit), timeline, content themes
  ↓
Content Creator: Generates 60 posts + 5 emails + 2 blog posts
  ↓
Scheduler: Queues at optimal times (cron workers)
  ↓
Analytics: Day 7 report → what's working → PO adjusts strategy
  ↓
Loop: Generate → Post → Measure → Adapt (runs autonomously)
```

## Integrations (Pro tier)

| Platform | API | Features |
|----------|-----|----------|
| X (Twitter) | OAuth 2.0 | Post, schedule, thread, analytics |
| LinkedIn | OAuth 2.0 | Post, articles, company page |
| Instagram | Graph API | Post (via FB), stories, reels |
| TikTok | Marketing API | Post, analytics |
| Mailgun/SES | API key | Send emails, track opens/clicks |
| Google Search Console | OAuth | Track rankings, impressions |
| Plausible/CF Analytics | API | Page views, referrers |

## Community

- Discord: #marketing channel
- Marketplace: browse marketers, see past campaigns
- Templates: community-submitted campaign frameworks
- Case studies: successful campaigns with metrics shared by creators
- Challenges: weekly "market this product" prompts

## Tech Stack

- Cloudflare Workers (backend API + scheduler)
- D1 (campaigns, posts, analytics, marketplace)
- R2 (generated content, media assets)
- Durable Objects (AI agent sessions, campaign state)
- Workers AI (content generation)
- Cron Triggers (scheduled posting)
- Stripe Connect (creator payouts)
- OAuth 2.0 (social platform connections)
