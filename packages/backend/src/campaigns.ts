/**
 * Campaign + content management for ProMarketingStore.
 *
 * Routes:
 *   GET    /campaigns          -> list user's campaigns
 *   POST   /campaigns          -> create campaign
 *   GET    /campaigns/:id      -> get campaign
 *   PATCH  /campaigns/:id      -> update campaign
 *   DELETE /campaigns/:id      -> delete campaign
 *   GET    /content            -> list content pieces
 *   POST   /content            -> create content
 */

import { Hono } from 'hono';
import { requireUser, HttpError } from './auth.js';
import type { Env } from './types.js';

type AppEnv = { Bindings: Env };

export const campaignRoutes = new Hono<AppEnv>();

// ── Campaign CRUD ────────────────────────────────────────────────────

campaignRoutes.get('/campaigns', async (c) => {
  const user = await requireUser(c);
  const rows = await c.env.DB.prepare(
    'SELECT id, name, goal, audience, channels, status, created_at, updated_at FROM campaigns WHERE user_id = ? ORDER BY created_at DESC',
  )
    .bind(user.uid)
    .all<{
      id: string;
      name: string;
      goal: string | null;
      audience: string | null;
      channels: string;
      status: string;
      created_at: string;
      updated_at: string;
    }>();
  return c.json({
    campaigns: rows.results.map((r) => ({
      ...r,
      channels: JSON.parse(r.channels || '[]'),
    })),
  });
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
  const id = c.req.param('id');

  const row = await c.env.DB.prepare(
    'SELECT id, user_id, name, goal, audience, channels, status, created_at, updated_at FROM campaigns WHERE id = ? AND user_id = ?',
  )
    .bind(id, user.uid)
    .first<{
      id: string;
      user_id: string;
      name: string;
      goal: string | null;
      audience: string | null;
      channels: string;
      status: string;
      created_at: string;
      updated_at: string;
    }>();

  if (!row) throw new HttpError('campaign not found', 404);

  return c.json({
    ...row,
    channels: JSON.parse(row.channels || '[]'),
  });
});

campaignRoutes.patch('/campaigns/:id', async (c) => {
  const user = await requireUser(c);
  const id = c.req.param('id');

  // Verify ownership
  const existing = await c.env.DB.prepare(
    'SELECT id FROM campaigns WHERE id = ? AND user_id = ?',
  )
    .bind(id, user.uid)
    .first<{ id: string }>();
  if (!existing) throw new HttpError('campaign not found', 404);

  const body = await c.req.json<{
    name?: string;
    goal?: string;
    audience?: string;
    channels?: string[];
    status?: string;
  }>();

  const sets: string[] = [];
  const values: (string | null)[] = [];

  if (body.name !== undefined) {
    sets.push('name = ?');
    values.push(body.name);
  }
  if (body.goal !== undefined) {
    sets.push('goal = ?');
    values.push(body.goal);
  }
  if (body.audience !== undefined) {
    sets.push('audience = ?');
    values.push(body.audience);
  }
  if (body.channels !== undefined) {
    sets.push('channels = ?');
    values.push(JSON.stringify(body.channels));
  }
  if (body.status !== undefined) {
    sets.push('status = ?');
    values.push(body.status);
  }

  if (sets.length === 0) {
    throw new HttpError('no fields to update', 400);
  }

  sets.push("updated_at = datetime('now')");

  await c.env.DB.prepare(
    `UPDATE campaigns SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
  )
    .bind(...values, id, user.uid)
    .run();

  return c.json({ ok: true });
});

campaignRoutes.delete('/campaigns/:id', async (c) => {
  const user = await requireUser(c);
  const id = c.req.param('id');

  // Delete linked content first
  await c.env.DB.prepare(
    'DELETE FROM content WHERE campaign_id = ? AND user_id = ?',
  )
    .bind(id, user.uid)
    .run();

  const result = await c.env.DB.prepare(
    'DELETE FROM campaigns WHERE id = ? AND user_id = ?',
  )
    .bind(id, user.uid)
    .run();

  if ((result.meta?.changes ?? 0) === 0) {
    throw new HttpError('campaign not found', 404);
  }

  return c.json({ ok: true });
});

// ── Content CRUD ─────────────────────────────────────────────────────

campaignRoutes.get('/content', async (c) => {
  const user = await requireUser(c);
  const campaignId = c.req.query('campaign_id');

  let sql = 'SELECT id, campaign_id, type, platform, body, status, scheduled_at, created_at FROM content WHERE user_id = ?';
  const binds: string[] = [user.uid];

  if (campaignId) {
    sql += ' AND campaign_id = ?';
    binds.push(campaignId);
  }

  sql += ' ORDER BY created_at DESC';

  const rows = await c.env.DB.prepare(sql)
    .bind(...binds)
    .all<{
      id: string;
      campaign_id: string | null;
      type: string;
      platform: string | null;
      body: string;
      status: string;
      scheduled_at: string | null;
      created_at: string;
    }>();

  return c.json({ content: rows.results });
});

campaignRoutes.post('/content', async (c) => {
  const user = await requireUser(c);
  const body = await c.req.json<{
    campaign_id?: string;
    type: string;
    platform?: string;
    body: string;
    scheduled_at?: string;
  }>();

  if (!body.type || typeof body.type !== 'string') {
    throw new HttpError('type is required', 400);
  }
  if (!body.body || typeof body.body !== 'string') {
    throw new HttpError('body is required', 400);
  }

  // Verify campaign ownership if linked
  if (body.campaign_id) {
    const campaign = await c.env.DB.prepare(
      'SELECT id FROM campaigns WHERE id = ? AND user_id = ?',
    )
      .bind(body.campaign_id, user.uid)
      .first<{ id: string }>();
    if (!campaign) throw new HttpError('campaign not found', 404);
  }

  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO content (id, campaign_id, user_id, type, platform, body, status, scheduled_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, datetime('now'))`,
  )
    .bind(
      id,
      body.campaign_id ?? null,
      user.uid,
      body.type,
      body.platform ?? null,
      body.body,
      body.scheduled_at ?? null,
    )
    .run();

  return c.json({ id, type: body.type, status: 'draft' }, 201);
});
