# PLAN: Agentic Campaign Brain for ProMarketingStore

> Goal: let a Cloudflare-hosted agent plan, schedule, publish, measure, and revise marketing campaigns through social APIs, starting with Facebook Pages and Instagram Business/Creator accounts.

## Product shape

PMS needs an agentic campaign brain, not just a chat box. The agent should be able to:

1. Turn a user goal into a campaign strategy.
2. Generate channel-specific content and assets.
3. Build a scheduled post calendar.
4. Ask for approval at the right level.
5. Publish through connected social APIs.
6. Store receipts, errors, and metrics.
7. Adapt the remaining campaign based on results.

The first production version should be conservative: human approval required before the first publish, and per-campaign "autopilot" can only be enabled after the user has connected accounts, approved brand voice, and reviewed the first generated schedule.

## Architecture decision

Use two Cloudflare primitives with separate responsibilities:

- **Cloudflare Agents SDK / Durable Object agent**: stateful brain, campaign memory, user chat, tool selection, strategy revisions, brand voice, and decisions.
- **Cloudflare Workflows**: durable execution of long-running campaign runs: generate, wait for approval, sleep until scheduled time, publish, retry/poll, collect metrics, and continue for days or weeks.

The current PMS backend remains the public API boundary. It should create agent/workflow instances, read/write D1 state, and expose console endpoints.

```
Console
  -> PMS Backend API
    -> CampaignAgent Durable Object / Agents SDK
      -> AI Gateway / Workers AI / BYO model provider
      -> D1 campaign memory + event log
      -> R2 generated media assets
      -> CampaignWorkflow instances
        -> Meta Graph API / other social APIs
        -> D1 post attempts + metrics
```

Why this split:

- Agents give the product a durable "brain" with memory and chat/session state.
- Workflows are better for execution because they retry, sleep for days, wait for approvals/events, and resume after failures.
- D1 stays the source of truth for campaign state, approvals, scheduled posts, publish receipts, and audit logs.

References:

- Cloudflare Agents docs: https://developers.cloudflare.com/agents/
- Cloudflare Workflows docs: https://developers.cloudflare.com/workflows/
- Meta Instagram content publishing: https://developers.facebook.com/docs/instagram-platform/content-publishing/
- Meta Pages posts API: https://developers.facebook.com/docs/pages-api/posts/

## Cross-store stack decision

This plan was checked against the current pro-store stack:

- **PAGS**: API worker + host worker + MCP worker + Durable Object agent runtime. Strong precedent for agent instances, memory, knowledge, encrypted user credentials, typed tools, public/private instance separation, and auditability.
- **PAS**: platform API as the control plane, separate `agent-teams` Worker for long-running AI work, service bindings, local session verification, cost ledger, activity log, and deterministic system stages that agents cannot self-declare.
- **PWS**: typed domain tools over structured state, drafts vs publish, snapshots, undo/revert, per-tenant Durable Object isolation, and a renderer/publish boundary. This is the model for PMS campaign drafts and approvals.
- **PIS**: simple Worker Assets + D1 collaboration API. Useful as the thin-store baseline, but too small for PMS once live social posting starts.
- **PDS/PMUS**: same "PAS pattern" product shape: backend API, agent-teams, marketplace, R2 assets, DO sessions, Stripe Connect.

Decision: PMS should move toward the **PAGS/PAS pattern**, not remain a single static console plus small backend. The campaign brain gets its own Worker and Durable Object namespace. The PMS backend remains the API/control plane. Workflows own long-running execution.

Target repo shape:

```text
pms/platform/
├── packages/backend          PMS control-plane API: auth, campaigns, accounts, marketplace
├── packages/agent-brain      CampaignAgent DO: chat, memory, plans, typed marketing tools
├── packages/social           Provider adapters: Meta first, then LinkedIn/X/TikTok/email
├── packages/sdk              Browser/client SDK for PMS console and future apps
├── workers/host              Store + console host worker, later replacing static Pages-only flow
├── store                     Source HTML/SPA shell
└── docs                      Product/API/operations docs
```

Do not copy PWS's bun stack. PMS should follow PAS/PAGS/PIS with `pnpm@10.30.3`, Node >=22, Vitest, Wrangler 4, Hono, and Worker Assets/host Worker as needed. PWS is useful for domain modeling, not tooling.

## Boundary with ProAdStore

PMS is **organic and owned-channel marketing**:

- Facebook Page posts
- Instagram organic posts
- LinkedIn organic posts
- X posts
- TikTok organic posts
- Email sequences
- Blog/SEO content
- Organic analytics and campaign reporting

PADS is **paid media**:

- Meta Ads campaign creation and budgets
- Google Ads
- LinkedIn Ads
- TikTok Ads
- bid optimization, ROAS, creative fatigue, paid audiences

PMS may connect to Meta Graph API for organic posting. It should not create paid campaigns or manage ad spend; that belongs in PADS.

## Identity and billing decision

Current PMS backend has standalone Google OAuth. That is acceptable for the scaffold, but not the forward architecture.

Forward path:

- Reuse the shared pro identity/subscription pattern from PAS/PIS where possible.
- PMS sessions should be locally verifiable JWTs, but issued from the shared pro auth surface or exchanged from it.
- A user with the single `$9/mo` pro subscription should not need a separate PMS subscription.
- PMS marketplace transactions can still have separate Stripe Connect flows for marketer payouts.
- Social OAuth tokens are PMS-owned and stored in PMS D1 because they are product-specific credentials.

Migration rule: keep the existing `/v1/auth/google` until shared pro auth is wired, but new agent/social routes should be written so `requireUser()` can later accept exchanged PAS/OFO pro claims without changing route contracts.

## Agent model decision

Use **one CampaignAgent Durable Object per campaign**, with role-specific turns inside it, rather than five independent Workers.

Roles:

- **Marketing Director**: user chat, brief refinement, approvals, memory.
- **Strategist**: channel plan, audience, positioning, milestones.
- **Content Creator**: post/email/blog drafts, platform-specific variants.
- **Scheduler**: calendar, frequency caps, timezone, queue constraints.
- **Analyst**: metrics interpretation and plan revision.

This mirrors PAS Agent Teams but keeps PMS simpler:

- The DO is the orchestrator and memory holder.
- Roles are prompt/tool profiles, not separate services.
- Publishing is a deterministic system/workflow stage, not an LLM action.
- The agent can propose and revise; only workflow/provider adapters can publish.

PAGS patterns to port:

- memory table/key-value facts
- knowledge/brand voice docs
- task/status records
- typed tool allow-lists
- public audit log
- encrypted user/provider credentials

PAS Agent Teams patterns to port:

- activity log with tool input/output summaries
- cost ledger and monthly cap
- rate limits per campaign
- explicit lifecycle states
- deterministic system stages for irreversible actions
- WebSocket plus poll fallback for console updates

PWS patterns to port:

- draft vs live separation
- publish snapshots
- structural diff before approval
- `undo`/`discard draft` for generated content before it goes live
- typed tools instead of free-form JSON blobs

## MVP scope

### Include

- Facebook Page text/link/photo post publishing.
- Instagram image post publishing for Instagram Business/Creator accounts connected to a Facebook Page.
- Campaign planner that outputs a structured plan, not free-form prose.
- Content queue with statuses: `draft`, `needs_approval`, `approved`, `scheduled`, `publishing`, `published`, `failed`, `cancelled`.
- Human approval flow for generated posts.
- Idempotent publish attempts with external post IDs stored.
- Basic metrics ingestion: permalink, published timestamp, error code/message, and later engagement snapshots.

### Defer

- TikTok, LinkedIn, X.
- Reels/video publishing.
- Carousel publishing.
- Paid ads.
- Fully autonomous no-review campaigns.
- Marketplace creator handoff.

## Required Meta integration model

Meta posting is not a simple API key. PMS needs OAuth and app review.

Core model:

- User connects Facebook through OAuth.
- PMS receives a user token, exchanges/stores long-lived credentials as allowed.
- PMS lists Pages the user can manage.
- User selects a Facebook Page and connected Instagram account.
- PMS stores encrypted page/account tokens and IDs.
- Workflow publishes as the Page/account, never as PMS itself.

Expected account records:

- `provider`: `facebook` or `instagram`
- `account_id`: Facebook Page ID or Instagram User ID
- `display_name`
- `access_token_encrypted`
- `token_expires_at`
- `scopes`
- `page_id` for Instagram-linked records
- `status`: `connected`, `expired`, `revoked`, `error`

Security notes:

- Do not reuse `SESSION_SIGNING_KEY` for social tokens. Add a separate `SOCIAL_TOKEN_ENCRYPTION_KEY`.
- Store token scopes and token expiry so the agent can decide when it must ask the user to reconnect.
- Never expose decrypted tokens to the browser.

## Agent tool contract

The agent brain should only act through typed tools. This keeps behavior inspectable and testable.

```ts
type AgentTool =
  | { name: 'campaign.plan'; input: CampaignBrief }
  | { name: 'campaign.generatePosts'; input: { campaignId: string; planId: string } }
  | { name: 'campaign.requestApproval'; input: { campaignId: string; postIds: string[] } }
  | { name: 'campaign.schedule'; input: { campaignId: string; postIds: string[] } }
  | { name: 'social.publishPost'; input: { postId: string } }
  | { name: 'social.refreshMetrics'; input: { postId: string } }
  | { name: 'campaign.revisePlan'; input: { campaignId: string; reason: string } };
```

Tool rules:

- `social.publishPost` must reject unless the post is approved and has an idempotency key.
- `campaign.schedule` must reject posts scheduled in the past unless explicitly marked `publish_now`.
- `campaign.revisePlan` can change future drafts but cannot edit already published posts.
- All tools write an `agent_events` audit row.

## Workflow model

One workflow instance per campaign run.

Workflow outline:

1. Load campaign brief and connected social accounts.
2. Ask agent to create a structured campaign plan.
3. Generate post drafts.
4. Persist drafts as `campaign_posts`.
5. Wait for approval event.
6. For each approved post:
   - Sleep until `scheduled_at`.
   - Mark `publishing`.
   - Publish through provider adapter.
   - Store external ID/permalink/receipt.
   - Mark `published` or `failed`.
7. Sleep until metrics polling windows.
8. Fetch metrics snapshots.
9. Ask agent whether future drafts should be revised.
10. Repeat until campaign end.

Approvals:

- MVP: one approval event approves all draft posts in a campaign plan.
- Later: per-post approval and editable drafts in console.

Workflow API notes from current Cloudflare docs:

- Use `step.waitForEvent` for approval gates.
- Use `step.sleepUntil` for scheduled publish times.
- Sleeping/waiting workflow instances do not consume CPU while idle and do not count as actively running concurrency.

## D1 schema additions

Add these tables beside existing `campaigns` and `content`.

```sql
CREATE TABLE IF NOT EXISTS social_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL,
  page_id TEXT,
  display_name TEXT NOT NULL,
  access_token_encrypted TEXT NOT NULL,
  access_token_iv TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  token_expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'connected',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, provider, account_id)
);

CREATE TABLE IF NOT EXISTS campaign_runs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  agent_instance_id TEXT,
  workflow_instance_id TEXT,
  objective TEXT NOT NULL,
  plan_json TEXT,
  status TEXT NOT NULL DEFAULT 'planning',
  autopilot_level TEXT NOT NULL DEFAULT 'approve_first',
  cost_cap_usd REAL NOT NULL DEFAULT 20.0,
  cost_spent_usd REAL NOT NULL DEFAULT 0.0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaign_posts (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  run_id TEXT REFERENCES campaign_runs(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  social_account_id TEXT REFERENCES social_accounts(id),
  post_type TEXT NOT NULL DEFAULT 'text',
  body TEXT NOT NULL,
  media_r2_key TEXT,
  scheduled_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  approval_status TEXT NOT NULL DEFAULT 'pending',
  idempotency_key TEXT NOT NULL,
  external_post_id TEXT,
  external_permalink TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(idempotency_key)
);

CREATE TABLE IF NOT EXISTS post_attempts (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES campaign_posts(id),
  provider TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT,
  success INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS post_metrics (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES campaign_posts(id),
  provider TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  collected_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_events (
  id TEXT PRIMARY KEY,
  campaign_id TEXT REFERENCES campaigns(id),
  run_id TEXT REFERENCES campaign_runs(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaign_memory (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'agent',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(campaign_id, key)
);

CREATE TABLE IF NOT EXISTS brand_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  voice_json TEXT NOT NULL DEFAULT '{}',
  audience_json TEXT NOT NULL DEFAULT '{}',
  blocked_terms_json TEXT NOT NULL DEFAULT '[]',
  approval_rules_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cost_ledger (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES campaign_runs(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
```

CampaignAgent DO storage should hold hot per-campaign orchestration state:

- current role turn
- chat/message stream
- active draft plan
- pending tool calls
- WebSocket clients
- short-term working memory

D1 remains the queryable source of truth for campaigns, posts, approvals, attempts, metrics, cost, and audit logs.

## Backend routes

Add these API groups under `/v1`.

Auth/profile:

- Keep existing `POST /auth/google` and `GET /auth/me` during scaffold.
- Add later: `POST /auth/exchange` for shared pro auth token exchange, following PIS/PAGS style.

Social connections:

- `GET /social/providers`
- `GET /social/accounts`
- `POST /social/facebook/oauth/start`
- `GET /social/facebook/oauth/callback`
- `DELETE /social/accounts/:id`

Campaign agent:

- `POST /campaigns/:id/agent/plan`
- `POST /campaigns/:id/agent/start`
- `GET /campaigns/:id/runs/:runId`
- `POST /campaigns/:id/runs/:runId/approve`
- `POST /campaigns/:id/runs/:runId/cancel`

Posts:

- `GET /campaigns/:id/posts`
- `PATCH /posts/:id`
- `POST /posts/:id/approve`
- `POST /posts/:id/publish-now`
- `GET /posts/:id/attempts`
- `GET /posts/:id/metrics`

Brain runtime:

- `GET /campaigns/:id/brain` — current DO-backed campaign brain state
- `POST /campaigns/:id/brain/chat` — Marketing Director chat
- `GET /campaigns/:id/brain/events` — audit/activity stream
- `GET /campaigns/:id/brain/ws` — live WebSocket stream
- `GET /campaigns/:id/cost` — cap/spend summary
- `PATCH /campaigns/:id/cost` — update cap

## Provider adapter interface

Each social provider should implement the same internal interface. The workflow calls this adapter, not raw `fetch()` scattered through agent code.

```ts
interface SocialProviderAdapter {
  publish(input: PublishInput): Promise<PublishResult>;
  getMetrics(input: MetricsInput): Promise<MetricsResult>;
  validateConnection(accountId: string): Promise<ConnectionStatus>;
}
```

Meta adapter first:

- Facebook Page text/link/photo posts.
- Instagram image publishing with container creation, container status polling, then publish.
- Store the full request/response receipt in `post_attempts`.

## Safety rails

- Default `autopilot_level = approve_first`.
- Default paid campaign/ad actions are impossible in PMS; PADS owns paid ads.
- Enforce campaign-level posting budget: max posts/day/channel.
- Require connected account ownership check before every publish.
- Use idempotency keys so retries do not duplicate posts.
- Lock a post row before publish by transitioning `approved -> publishing`.
- Store provider responses for audit/debug.
- Add a kill switch: `campaign_runs.status = cancelled` prevents future publishes.
- Add platform-side content policy checks before approval/publish.
- Add Turnstile to public OAuth/connect entry points if abuse appears.
- Add monthly AI cost cap per campaign and auto-pause when exceeded.
- Add per-provider rate limits and cooldowns, stored in D1.
- Require explicit user approval before first real post from each connected account.
- Keep a full receipt for every irreversible external API call.

## Implementation phases

### Phase 0: Align the repo with pro-store conventions

- Convert PMS from one backend package plus static pages into a pnpm workspace matching PAGS/PAS/PIS.
- Keep `packages/backend` as the current Hono Worker.
- Add `packages/agent-brain` and `packages/social`.
- Add root `pnpm-workspace.yaml`, root scripts, TypeScript base config, Vitest.
- Upgrade Wrangler to v4 and workers-types to current repo convention.
- Keep the existing static store working while the host Worker decision is made.

Exit criteria:

- `pnpm build`, `pnpm typecheck`, and focused backend tests run from repo root.
- Current backend behavior unchanged.

### Phase 1: Backend-backed campaign control plane

- Add schema tables.
- Add `agent_events`.
- Add `campaign_runs`, `campaign_posts`, `campaign_memory`, `brand_profiles`, `cost_ledger`.
- Add backend routes for campaigns, runs, posts, approvals, and cost.
- Wire console campaigns/content/calendar to backend instead of `localStorage`.
- Keep a deterministic non-LLM planner fallback so the product can be tested without model credentials.

Exit criteria:

- A user can create a campaign, generate a draft plan, see draft posts, approve/cancel posts, and reload the console without losing state.

### Phase 2: CampaignAgent Durable Object

- Add `packages/agent-brain` Worker with one CampaignAgent DO per campaign.
- Add chat, role profiles, memory, activity log, and cost ledger writes.
- Add typed tools: plan, generate posts, remember, revise plan, request approval.
- Add WebSocket plus poll fallback for live console updates.
- Route backend `/campaigns/:id/brain/*` to the DO through service binding or direct binding.

Exit criteria:

- User chats with Marketing Director.
- Agent creates a structured plan and draft post set.
- All tool calls appear in audit log.
- Cost cap/rate limit can stop a runaway run.

### Phase 3: Meta social account connections

- Add Meta OAuth start/callback.
- Store encrypted Facebook Page and Instagram account tokens in `social_accounts`.
- Add separate `SOCIAL_TOKEN_ENCRYPTION_KEY`.
- Add console settings view for connected accounts.
- Add health check/reconnect status.
- Add provider capability discovery: can post text, image, link, metrics.

Exit criteria:

- User can connect a Facebook Page and linked Instagram account.
- PMS can validate connection and list target accounts.
- No decrypted token reaches the browser.

### Phase 4: Approval and schedule queue

- Generate campaign posts into `campaign_posts`.
- Build approval UI with structural diff and brand checklist.
- Add `approved/scheduled/cancelled` transitions.
- Add idempotency keys and row-locking behavior.
- Add draft snapshots before approval, following the PWS publish model.

Exit criteria:

- User can approve a campaign batch, edit individual posts, cancel a scheduled post, and see an audit trail.

### Phase 5: Workflow execution

- Add `CampaignWorkflow`.
- Start workflow from `/campaigns/:id/agent/start`.
- Use Workflows for wait-for-approval, sleeping until scheduled times, retries, and metrics polling.
- Store workflow instance IDs in `campaign_runs`.
- Add cancel path that prevents future publishes.

Exit criteria:

- Approved posts move through scheduled states without cron hand-rolled bookkeeping.
- Cancelling a campaign prevents later publishes.

### Phase 6: Meta publishing MVP

- Implement Facebook Page post publishing.
- Implement Instagram image post publishing.
- Store external IDs/permalinks.
- Add retry and failure surfacing in console.

Exit criteria:

- Test account can publish one Facebook Page post and one Instagram image post.
- Duplicate workflow retries do not duplicate posts.
- Failed provider calls produce actionable UI errors.

### Phase 7: Metrics and adaptation

- Poll metrics after configurable windows.
- Store metrics snapshots.
- Ask the agent to revise future draft posts based on performance.
- Keep all plan revisions in `agent_events`.

Exit criteria:

- Analyst role can produce a weekly report from stored metrics.
- Future drafts can be revised without touching published posts.

### Phase 8: Marketplace handoff

- Add marketer profiles/services/orders after self-service campaign execution works.
- Let client grant marketer approval rights per campaign.
- Keep connected social accounts owned by the client.
- Add Stripe Connect only after there is a real service flow to charge for.

Exit criteria:

- A marketer can manage a client campaign without seeing raw social tokens.
- All marketer actions are attributed in audit logs.

## Open questions

- Which LLM should be first-class: Workers AI for included quota, OpenAI via AI Gateway, or user BYO key? Default: route provider calls through AI Gateway and support BYO where possible, matching PAS.
- Should PMS require approval for every post forever, or allow campaign-level autopilot after the first approved batch? Default: `approve_first`, then campaign-level autopilot only after successful first publish per account.
- Should generated media be supported in MVP, or only text/link/image URLs supplied by the user?
- Should marketplace creators be able to approve posts on behalf of a client?
- Is PMS using `promarketingstore.online` now, or still Pages preview URLs for OAuth callback setup?
- Should PMS use a host Worker immediately, or keep static Pages until the console needs Worker Assets and `/console` auth cookies?

## Immediate next implementation target

Build Phase 0 and Phase 1 first:

1. Convert the repo to a pnpm workspace without changing runtime behavior.
2. Add the D1 tables and backend routes for runs/posts/approvals/cost.
3. Add a deterministic non-LLM planner fallback so the UI works without model credentials.
4. Move console campaigns/content/calendar from `localStorage` to backend-backed state.

That creates the durable control plane. CampaignAgent, Meta OAuth, Workflows, and live publishing can then land without changing the user-facing model.
