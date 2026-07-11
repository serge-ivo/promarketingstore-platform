# PMS and FMS Product Boundary

ProMarketingStore is the paid marketing execution platform. FreeMarketingStore is the free diagnostics and planning platform.

## Short Version

- **FMS**: diagnose, plan, generate, export, and explain what to fix.
- **PMS**: execute, publish, send, measure, and optimize campaigns.

## Boundary Rule

If a feature gives advice, generates a draft, audits a public website, or helps the user plan, it belongs in FMS.

If a feature uses connected accounts, schedules work, publishes content, sends email, runs agents over time, or changes live campaign state, it belongs in PMS.

## PMS Owns

- Paid account and subscription.
- Brand memory and campaign context.
- Campaign agent sessions.
- Campaign plans, drafts, approvals, schedules, and event logs.
- Social OAuth and publishing.
- Email sending and sequence execution.
- Cross-channel analytics.
- Optimization loop from campaign results.
- Creator marketplace and service packages.
- Team/client approval workflow.

## FMS Owns

- Free account.
- Saved websites and audit history.
- Website health and Search Console readiness.
- Cloudflare DNS verification setup for Google properties.
- AI-ready issue prompts.
- SEO/content/campaign planning tools.
- Exports and handoff into PMS.

## Handoff Model

FMS should produce a Marketing Readiness Profile:

- Website health.
- Search readiness.
- Tracking readiness.
- Content readiness.
- Trust/security readiness.
- Campaign readiness.

PMS should consume that profile and offer:

> Create a 30-day campaign from this site.

The PMS campaign agent should use the FMS readiness data as input, not rerun every free diagnostic internally.

## PMS Should Not Become

- A generic collection of free calculators.
- A duplicate website audit tool.
- A static Search Console dashboard with no campaign action.
- A paid version of every FMS generator.

PMS should be judged by whether it causes marketing work to happen safely and measurably.

## Pricing Boundary

FMS sign-in can be free because it stores diagnostic and planning state.

PMS should charge because it consumes execution resources and takes higher-trust actions:

- Scheduled jobs.
- Agent sessions.
- Social/API credentials.
- Email sending.
- Campaign analytics.
- Marketplace transactions.

## Paid Ads

PMS may generate paid-ad copy and campaign plans, but actual ad spend management should be isolated.

If paid media becomes a major product, use a separate ProAdStore/PADS boundary or a hard PMS module boundary for:

- Budgets.
- Bidding.
- Audiences.
- ROAS.
- Creative fatigue.
- Spend approvals.
