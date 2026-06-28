import type { Context, Hono } from 'hono';
import { HttpError, requireUser } from './auth.js';
import { appendAgentEvent, getOwnedCampaign } from './campaign-store.js';
import { buildDeterministicCampaignPlan } from './planner.js';
import type { Env } from './types.js';

type AppEnv = { Bindings: Env };
type RouteContext = Context<AppEnv>;

function routeParam(c: RouteContext, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new HttpError(`missing route param: ${name}`, 400);
  return value;
}

async function planCampaign(c: RouteContext): Promise<Response> {
  const user = await requireUser(c);
  const campaign = await getOwnedCampaign(c.env, routeParam(c, 'id'), user.uid);
  const body = await c.req
    .json<{ objective?: string; costCapUsd?: number }>()
    .catch((): { objective?: string; costCapUsd?: number } => ({}));
  const plan = buildDeterministicCampaignPlan(campaign);
  const runId = crypto.randomUUID();
  const objective = body.objective?.trim() || campaign.goal || plan.summary;
  const costCap = typeof body.costCapUsd === 'number' ? Math.max(1, Math.min(1000, body.costCapUsd)) : 20;

  await c.env.DB.prepare(
    `INSERT INTO campaign_runs
       (id, campaign_id, user_id, agent_instance_id, workflow_instance_id, objective, plan_json, status,
        autopilot_level, cost_cap_usd, cost_spent_usd, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 'draft_ready', 'approve_first', ?, 0, datetime('now'), datetime('now'))`,
  )
    .bind(runId, campaign.id, user.uid, `campaign:${campaign.id}`, objective, JSON.stringify(plan), costCap)
    .run();

  for (const post of plan.posts) {
    await c.env.DB.prepare(
      `INSERT INTO campaign_posts
         (id, campaign_id, run_id, user_id, provider, social_account_id, post_type, body, scheduled_at,
          status, approval_status, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'draft', 'pending', ?, datetime('now'), datetime('now'))`,
    )
      .bind(
        crypto.randomUUID(),
        campaign.id,
        runId,
        user.uid,
        post.provider,
        post.postType,
        post.body,
        post.scheduledAt,
        `pms:${runId}:${post.provider}:${post.scheduledAt}`,
      )
      .run();
  }

  await appendAgentEvent(c.env, {
    campaignId: campaign.id,
    runId,
    userId: user.uid,
    type: 'campaign.plan.created',
    payload: { plan, source: 'deterministic-fallback' },
  });

  return c.json({ runId, plan, status: 'draft_ready' }, 201);
}

async function startCampaign(c: RouteContext): Promise<Response> {
  const user = await requireUser(c);
  const campaign = await getOwnedCampaign(c.env, routeParam(c, 'id'), user.uid);
  const existing = await c.env.DB.prepare(
    `SELECT id, plan_json, status FROM campaign_runs
     WHERE campaign_id = ? AND user_id = ? AND status IN ('draft_ready', 'approved', 'scheduled')
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(campaign.id, user.uid)
    .first<{ id: string; plan_json: string | null; status: string }>();

  if (!existing) throw new HttpError('create a campaign plan before starting', 409);

  await c.env.DB.prepare(
    `UPDATE campaign_runs SET status = 'scheduled', updated_at = datetime('now')
     WHERE id = ? AND user_id = ?`,
  )
    .bind(existing.id, user.uid)
    .run();

  await c.env.DB.prepare(
    `UPDATE campaign_posts SET status = 'scheduled', updated_at = datetime('now')
     WHERE run_id = ? AND user_id = ? AND approval_status = 'approved'`,
  )
    .bind(existing.id, user.uid)
    .run();

  await appendAgentEvent(c.env, {
    campaignId: campaign.id,
    runId: existing.id,
    userId: user.uid,
    type: 'campaign.run.started',
    payload: { workflow: 'deferred-phase-5' },
  });

  return c.json({ runId: existing.id, status: 'scheduled' });
}

async function getCampaignRun(c: RouteContext): Promise<Response> {
  const user = await requireUser(c);
  const campaign = await getOwnedCampaign(c.env, routeParam(c, 'id'), user.uid);
  const run = await c.env.DB.prepare(
    `SELECT id, campaign_id, user_id, agent_instance_id, workflow_instance_id, objective, plan_json, status,
            autopilot_level, cost_cap_usd, cost_spent_usd, created_at, updated_at
     FROM campaign_runs WHERE id = ? AND campaign_id = ? AND user_id = ?`,
  )
    .bind(routeParam(c, 'runId'), campaign.id, user.uid)
    .first<{
      id: string;
      campaign_id: string;
      user_id: string;
      agent_instance_id: string | null;
      workflow_instance_id: string | null;
      objective: string;
      plan_json: string | null;
      status: string;
      autopilot_level: string;
      cost_cap_usd: number;
      cost_spent_usd: number;
      created_at: string;
      updated_at: string;
    }>();
  if (!run) throw new HttpError('run not found', 404);
  return c.json({ ...run, plan: run.plan_json ? JSON.parse(run.plan_json) : null });
}

async function approveCampaignRun(c: RouteContext): Promise<Response> {
  const user = await requireUser(c);
  const campaign = await getOwnedCampaign(c.env, routeParam(c, 'id'), user.uid);
  const runId = routeParam(c, 'runId');

  const run = await c.env.DB.prepare('SELECT id FROM campaign_runs WHERE id = ? AND campaign_id = ? AND user_id = ?')
    .bind(runId, campaign.id, user.uid)
    .first<{ id: string }>();
  if (!run) throw new HttpError('run not found', 404);

  await c.env.DB.prepare(
    `UPDATE campaign_posts
     SET approval_status = 'approved', status = 'approved', updated_at = datetime('now')
     WHERE run_id = ? AND user_id = ? AND status = 'draft'`,
  )
    .bind(runId, user.uid)
    .run();

  await c.env.DB.prepare(
    `UPDATE campaign_runs SET status = 'approved', updated_at = datetime('now')
     WHERE id = ? AND user_id = ?`,
  )
    .bind(runId, user.uid)
    .run();

  await appendAgentEvent(c.env, {
    campaignId: campaign.id,
    runId,
    userId: user.uid,
    type: 'campaign.run.approved',
    payload: { approvalMode: 'batch' },
  });

  return c.json({ ok: true, runId, status: 'approved' });
}

async function cancelCampaignRun(c: RouteContext): Promise<Response> {
  const user = await requireUser(c);
  const campaign = await getOwnedCampaign(c.env, routeParam(c, 'id'), user.uid);
  const runId = routeParam(c, 'runId');

  await c.env.DB.prepare(
    `UPDATE campaign_runs SET status = 'cancelled', updated_at = datetime('now')
     WHERE id = ? AND campaign_id = ? AND user_id = ?`,
  )
    .bind(runId, campaign.id, user.uid)
    .run();
  await c.env.DB.prepare(
    `UPDATE campaign_posts SET status = 'cancelled', updated_at = datetime('now')
     WHERE run_id = ? AND user_id = ? AND status IN ('draft', 'approved', 'scheduled')`,
  )
    .bind(runId, user.uid)
    .run();

  await appendAgentEvent(c.env, {
    campaignId: campaign.id,
    runId,
    userId: user.uid,
    type: 'campaign.run.cancelled',
    payload: {},
  });

  return c.json({ ok: true, runId, status: 'cancelled' });
}

async function getCampaignCost(c: RouteContext): Promise<Response> {
  const user = await requireUser(c);
  const campaign = await getOwnedCampaign(c.env, routeParam(c, 'id'), user.uid);
  const summary = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM cost_ledger
     WHERE campaign_id = ? AND user_id = ?`,
  )
    .bind(campaign.id, user.uid)
    .first<{ spent: number }>();
  const latestRun = await c.env.DB.prepare(
    `SELECT id, cost_cap_usd, cost_spent_usd FROM campaign_runs
     WHERE campaign_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(campaign.id, user.uid)
    .first<{ id: string; cost_cap_usd: number; cost_spent_usd: number }>();

  return c.json({
    campaignId: campaign.id,
    runId: latestRun?.id ?? null,
    capUsd: latestRun?.cost_cap_usd ?? 20,
    spentUsd: summary?.spent ?? latestRun?.cost_spent_usd ?? 0,
  });
}

async function updateCampaignCost(c: RouteContext): Promise<Response> {
  const user = await requireUser(c);
  const campaign = await getOwnedCampaign(c.env, routeParam(c, 'id'), user.uid);
  const body = await c.req.json<{ costCapUsd: number }>();
  if (typeof body.costCapUsd !== 'number' || body.costCapUsd < 1 || body.costCapUsd > 1000) {
    throw new HttpError('costCapUsd must be between 1 and 1000', 400);
  }
  await c.env.DB.prepare(
    `UPDATE campaign_runs SET cost_cap_usd = ?, updated_at = datetime('now')
     WHERE campaign_id = ? AND user_id = ?`,
  )
    .bind(body.costCapUsd, campaign.id, user.uid)
    .run();
  return c.json({ ok: true, campaignId: campaign.id, capUsd: body.costCapUsd });
}

export function registerCampaignRunRoutes(routes: Hono<AppEnv>) {
  routes.post('/campaigns/:id/agent/plan', planCampaign);
  routes.post('/campaigns/:id/agent/start', startCampaign);
  routes.get('/campaigns/:id/runs/:runId', getCampaignRun);
  routes.post('/campaigns/:id/runs/:runId/approve', approveCampaignRun);
  routes.post('/campaigns/:id/runs/:runId/cancel', cancelCampaignRun);
  routes.get('/campaigns/:id/cost', getCampaignCost);
  routes.patch('/campaigns/:id/cost', updateCampaignCost);
}
