import type { Context, Hono } from 'hono';
import { HttpError, requireUser } from './auth.js';
import { appendAgentEvent, getOwnedCampaign, getOwnedPost } from './campaign-store.js';
import { getOwnedSocialAccount } from './publisher.js';
import type { Env } from './types.js';

type AppEnv = { Bindings: Env };
type RouteContext = Context<AppEnv>;

function routeParam(c: RouteContext, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new HttpError(`missing route param: ${name}`, 400);
  return value;
}

const MUTABLE_STATUSES = ['draft', 'approved', 'scheduled', 'failed', 'cancelled'] as const;
type MutablePostStatus = (typeof MUTABLE_STATUSES)[number];

function normalizeStatus(input: string | undefined): MutablePostStatus | undefined {
  if (input === undefined) return undefined;
  const status = input.toLowerCase().replace(/[\s-]+/g, '_');
  if (status === 'needs_approval') return 'draft';
  if (status === 'blocked' || status === 'canceled') return status === 'blocked' ? 'failed' : 'cancelled';
  if ((MUTABLE_STATUSES as readonly string[]).includes(status)) return status as MutablePostStatus;
  throw new HttpError('unsupported post status', 400);
}

function nextApprovalStatus(
  status: MutablePostStatus | undefined,
  explicit: string | undefined,
  current: string,
): string {
  if (explicit !== undefined) {
    if (!['pending', 'approved', 'rejected'].includes(explicit))
      throw new HttpError('unsupported approval status', 400);
    return explicit;
  }
  if (status === 'approved' || status === 'scheduled') return 'approved';
  if (status === 'draft') return 'pending';
  return current;
}

async function listCampaignPosts(c: RouteContext): Promise<Response> {
  const user = await requireUser(c);
  const campaign = await getOwnedCampaign(c.env, routeParam(c, 'id'), user.uid);
  const rows = await c.env.DB.prepare(
    `SELECT id, campaign_id, run_id, provider, social_account_id, post_type, body, media_r2_key,
            scheduled_at, status, approval_status, idempotency_key, external_post_id,
            external_permalink, last_error_code, last_error_message, created_at, updated_at
     FROM campaign_posts WHERE campaign_id = ? AND user_id = ? ORDER BY scheduled_at ASC, created_at ASC`,
  )
    .bind(campaign.id, user.uid)
    .all();
  return c.json({ posts: rows.results });
}

async function updateCampaignPost(c: RouteContext): Promise<Response> {
  const user = await requireUser(c);
  const post = await getOwnedPost(c.env, routeParam(c, 'id'), user.uid);
  if (['publishing', 'published'].includes(post.status)) {
    throw new HttpError('published posts cannot be edited', 409);
  }

  const body = await c.req.json<{
    body?: string;
    scheduled_at?: string | null;
    scheduledAt?: string | null;
    status?: string;
    approvalStatus?: string;
    socialAccountId?: string | null;
    mediaUrl?: string | null;
  }>();
  if (
    body.body === undefined &&
    body.scheduled_at === undefined &&
    body.scheduledAt === undefined &&
    body.status === undefined &&
    body.approvalStatus === undefined &&
    body.socialAccountId === undefined &&
    body.mediaUrl === undefined
  ) {
    throw new HttpError('no fields to update', 400);
  }
  if (body.body !== undefined && !body.body.trim()) throw new HttpError('body cannot be empty', 400);

  const status = normalizeStatus(body.status);
  const scheduledAt = body.scheduled_at !== undefined ? body.scheduled_at : body.scheduledAt;
  const mediaKey = body.mediaUrl !== undefined ? body.mediaUrl : post.media_r2_key;
  let socialAccountId = body.socialAccountId !== undefined ? body.socialAccountId : post.social_account_id;
  if (socialAccountId) {
    await getOwnedSocialAccount(c.env, socialAccountId, user.uid);
  } else {
    socialAccountId = null;
  }
  if (status === 'scheduled' && !socialAccountId)
    throw new HttpError('socialAccountId is required before scheduling', 400);
  const approvalStatus = nextApprovalStatus(status, body.approvalStatus, post.approval_status);

  await c.env.DB.prepare(
    `UPDATE campaign_posts
     SET body = ?, scheduled_at = ?, status = ?, approval_status = ?, social_account_id = ?, media_r2_key = ?,
         updated_at = datetime('now')
     WHERE id = ? AND user_id = ?`,
  )
    .bind(
      body.body ?? post.body,
      scheduledAt !== undefined ? scheduledAt : post.scheduled_at,
      status ?? post.status,
      approvalStatus,
      socialAccountId,
      mediaKey,
      post.id,
      user.uid,
    )
    .run();

  await appendAgentEvent(c.env, {
    campaignId: post.campaign_id,
    runId: post.run_id,
    userId: user.uid,
    type: 'campaign.post.updated',
    payload: { postId: post.id, fields: Object.keys(body) },
  });

  return c.json({ ok: true });
}

async function approveCampaignPost(c: RouteContext): Promise<Response> {
  const user = await requireUser(c);
  const post = await getOwnedPost(c.env, routeParam(c, 'id'), user.uid);
  if (post.status === 'cancelled') throw new HttpError('cancelled posts cannot be approved', 409);

  await c.env.DB.prepare(
    `UPDATE campaign_posts
     SET approval_status = 'approved', status = 'approved', updated_at = datetime('now')
     WHERE id = ? AND user_id = ?`,
  )
    .bind(post.id, user.uid)
    .run();

  await appendAgentEvent(c.env, {
    campaignId: post.campaign_id,
    runId: post.run_id,
    userId: user.uid,
    type: 'campaign.post.approved',
    payload: { postId: post.id },
  });

  return c.json({ ok: true, postId: post.id, status: 'approved' });
}

export function registerCampaignPostRoutes(routes: Hono<AppEnv>) {
  routes.get('/campaigns/:id/posts', listCampaignPosts);
  routes.patch('/posts/:id', updateCampaignPost);
  routes.post('/posts/:id/approve', approveCampaignPost);
}
