/**
 * Campaign CRUD routes. Agent-run and content routes are registered from
 * adjacent modules so each route surface stays small enough to reason about.
 */

import { Hono } from 'hono';
import { HttpError, requireUser } from './auth.js';
import { registerCampaignAgentRoutes } from './campaign-agent-routes.js';
import { type CampaignRow, getOwnedCampaign, serializeCampaign } from './campaign-store.js';
import { registerContentRoutes } from './content-routes.js';
import type { Env } from './types.js';

type AppEnv = { Bindings: Env };

export const campaignRoutes = new Hono<AppEnv>();

campaignRoutes.get('/campaigns', async (c) => {
  const user = await requireUser(c);
  const rows = await c.env.DB.prepare(
    'SELECT id, user_id, name, goal, audience, channels, status, created_at, updated_at FROM campaigns WHERE user_id = ? ORDER BY created_at DESC',
  )
    .bind(user.uid)
    .all<CampaignRow>();
  return c.json({ campaigns: rows.results.map(serializeCampaign) });
});

campaignRoutes.post('/campaigns', async (c) => {
  const user = await requireUser(c);
  const body = await c.req.json<{
    name: string;
    goal?: string;
    audience?: string;
    channels?: string[];
  }>();

  if (!body.name || typeof body.name !== 'string') {
    throw new HttpError('name is required', 400);
  }

  const id = crypto.randomUUID();
  const channels = JSON.stringify(body.channels ?? []);

  await c.env.DB.prepare(
    `INSERT INTO campaigns (id, user_id, name, goal, audience, channels, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'draft', datetime('now'), datetime('now'))`,
  )
    .bind(id, user.uid, body.name, body.goal ?? null, body.audience ?? null, channels)
    .run();

  return c.json({ id, name: body.name, status: 'draft' }, 201);
});

campaignRoutes.get('/campaigns/:id', async (c) => {
  const user = await requireUser(c);
  const row = await getOwnedCampaign(c.env, c.req.param('id'), user.uid);
  return c.json(serializeCampaign(row));
});

campaignRoutes.patch('/campaigns/:id', async (c) => {
  const user = await requireUser(c);
  const id = c.req.param('id');
  const existing = await getOwnedCampaign(c.env, id, user.uid);

  const body = await c.req.json<{
    name?: string;
    goal?: string;
    audience?: string;
    channels?: string[];
    status?: string;
  }>();

  if (
    body.name === undefined &&
    body.goal === undefined &&
    body.audience === undefined &&
    body.channels === undefined &&
    body.status === undefined
  ) {
    throw new HttpError('no fields to update', 400);
  }

  await c.env.DB.prepare(
    `UPDATE campaigns
     SET name = ?, goal = ?, audience = ?, channels = ?, status = ?, updated_at = datetime('now')
     WHERE id = ? AND user_id = ?`,
  )
    .bind(
      body.name ?? existing.name,
      body.goal ?? existing.goal,
      body.audience ?? existing.audience,
      body.channels !== undefined ? JSON.stringify(body.channels) : existing.channels,
      body.status ?? existing.status,
      id,
      user.uid,
    )
    .run();

  return c.json({ ok: true });
});

campaignRoutes.delete('/campaigns/:id', async (c) => {
  const user = await requireUser(c);
  const id = c.req.param('id');

  await c.env.DB.prepare('DELETE FROM campaign_posts WHERE campaign_id = ? AND user_id = ?').bind(id, user.uid).run();
  await c.env.DB.prepare('DELETE FROM campaign_runs WHERE campaign_id = ? AND user_id = ?').bind(id, user.uid).run();
  await c.env.DB.prepare('DELETE FROM content WHERE campaign_id = ? AND user_id = ?').bind(id, user.uid).run();

  const result = await c.env.DB.prepare('DELETE FROM campaigns WHERE id = ? AND user_id = ?').bind(id, user.uid).run();

  if ((result.meta?.changes ?? 0) === 0) throw new HttpError('campaign not found', 404);
  return c.json({ ok: true });
});

registerCampaignAgentRoutes(campaignRoutes);
registerContentRoutes(campaignRoutes);
