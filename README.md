# ProMarketingStore

**promarketingstore.online** — AI-powered marketing automation. Autonomous campaign execution, content distribution, analytics — all from a prompt.

## What it is

ProMarketingStore is the paid tier of FreeMarketingStore. While FreeMarketingStore gives you planning tools (calendars, generators, SEO), ProMarketingStore EXECUTES:

1. **AI Campaign Agent** — describe your goal, AI plans AND runs the campaign
2. **Social Media Autopilot** — generates content, schedules, posts to X/LinkedIn/Instagram/TikTok
3. **Creator Marketplace** — hire marketers for campaigns, or offer your services
4. **Prompt Campaign Services** — "Launch my SaaS in 30 days" → full campaign planned and executed
5. **Analytics Dashboard** — real-time metrics across all channels, AI-powered insights

## Architecture (follows PAS pattern)

```
pms/platform/
├── packages/
│   ├── sdk/           @promarketingstore/sdk — marketing API client
│   ├── agent-teams/   AI marketing agents (PO → Strategist → Content → Analytics)
│   ├── backend/       Hono API worker (campaigns, scheduling, analytics, billing)
│   └── cli/           pms CLI
├── store/             Store site (promarketingstore.online)
├── workers/           CF Workers (agent, scheduler, analytics, admin)
└── .github/workflows/ CI/CD
```

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
