import type { Context, Hono } from 'hono';
import { HttpError, requireUser } from './auth.js';
import { getOwnedCampaign } from './campaign-store.js';
import type { Env } from './types.js';

type AppEnv = { Bindings: Env };
type RouteContext = Context<AppEnv>;

async function listContent(c: RouteContext): Promise<Response> {
  const user = await requireUser(c);
  const campaignId = c.req.query('campaign_id');

  let sql =
    'SELECT id, campaign_id, type, platform, body, status, scheduled_at, created_at FROM content WHERE user_id = ?';
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
}

async function createContent(c: RouteContext): Promise<Response> {
  const user = await requireUser(c);
  const body = await c.req.json<{
    campaign_id?: string;
    type: string;
    platform?: string;
    body: string;
    scheduled_at?: string;
  }>();

  if (!body.type || typeof body.type !== 'string') throw new HttpError('type is required', 400);
  if (!body.body || typeof body.body !== 'string') throw new HttpError('body is required', 400);

  if (body.campaign_id) await getOwnedCampaign(c.env, body.campaign_id, user.uid);

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
}

export function registerContentRoutes(routes: Hono<AppEnv>) {
  routes.get('/content', listContent);
  routes.post('/content', createContent);
}
