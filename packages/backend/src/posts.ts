import { Hono } from 'hono';
import { HttpError, requireUser } from './auth.js';
import { decryptSecret } from './secret-crypto.js';
import { MetaOrganicAdapter, XAdapter } from '@pms/social';
import { metaGraph, requireSocialTokenKey } from './social-meta.js';
import { refreshXToken } from './social-x.js';
import { getOwnedSocialAccount, type SocialAccountRow } from './publisher.js';
import { checkRateLimit, incrementRateLimit } from './rate-limit.js';
import type { Env } from './types.js';

type AppEnv = { Bindings: Env };

export const postsRoutes = new Hono<AppEnv>();

interface PostRow {
  id: string;
  user_id: string;
  social_account_id: string | null;
  campaign_id: string | null;
  source_content_id: string | null;
  platform: string;
  content: string;
  media_key: string | null;
  media_type: string | null;
  scheduled_for: string | null;
  posted_at: string | null;
  platform_post_id: string | null;
  status: string;
  error: string | null;
  retry_count: number;
  caption_hash: string | null;
  created_at: string;
  updated_at: string;
}

async function captionHash(caption: string): Promise<string> {
  const data = new TextEncoder().encode(caption.trim().toLowerCase());
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

async function getOwnedPostRow(env: Env, postId: string, userId: string): Promise<PostRow> {
  const row = await env.DB.prepare(
    `SELECT id, user_id, social_account_id, campaign_id, source_content_id, platform, content, media_key, media_type,
            scheduled_for, posted_at, platform_post_id, status, error, retry_count, caption_hash,
            created_at, updated_at
     FROM posts WHERE id = ? AND user_id = ?`,
  )
    .bind(postId, userId)
    .first<PostRow>();
  if (!row) throw new HttpError('post not found', 404);
  return row;
}

function serializePost(row: PostRow) {
  return {
    id: row.id,
    socialAccountId: row.social_account_id,
    campaignId: row.campaign_id,
    platform: row.platform,
    content: row.content,
    mediaKey: row.media_key,
    mediaType: row.media_type,
    scheduledFor: row.scheduled_for,
    postedAt: row.posted_at,
    platformPostId: row.platform_post_id,
    status: row.status,
    error: row.error,
    retryCount: row.retry_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET /posts — list user's standalone posts
postsRoutes.get('/posts', async (c) => {
  const user = await requireUser(c);
  const status = c.req.query('status');
  const platform = c.req.query('platform');
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
  const offset = parseInt(c.req.query('offset') || '0', 10);

  let sql = `SELECT id, user_id, social_account_id, campaign_id, platform, content, media_key, media_type,
                    scheduled_for, posted_at, platform_post_id, status, error, retry_count, caption_hash,
                    created_at, updated_at
             FROM posts WHERE user_id = ?`;
  const params: unknown[] = [user.uid];

  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (platform) {
    sql += ' AND platform = ?';
    params.push(platform);
  }
  sql += ' ORDER BY COALESCE(scheduled_for, created_at) DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = await c.env.DB.prepare(sql).bind(...params).all<PostRow>();
  return c.json({ posts: rows.results.map(serializePost) });
});

// POST /posts — create a draft or scheduled post
postsRoutes.post('/posts', async (c) => {
  const user = await requireUser(c);
  const body = await c.req.json<{
    platform: string;
    content: string;
    socialAccountId?: string;
    scheduledFor?: string;
    mediaKey?: string;
    mediaType?: string;
  }>();

  if (!body.platform || !body.content) {
    return c.json({ error: 'platform and content are required' }, 400);
  }
  const validPlatforms = ['facebook', 'instagram', 'x', 'linkedin', 'tiktok'];
  if (!validPlatforms.includes(body.platform)) {
    return c.json({ error: `invalid platform, must be one of: ${validPlatforms.join(', ')}` }, 400);
  }

  // Duplicate detection
  const hash = await captionHash(body.content);
  if (body.socialAccountId) {
    const dup = await c.env.DB.prepare(
      "SELECT id FROM posts WHERE social_account_id = ? AND caption_hash = ? AND status = 'posted' LIMIT 1",
    )
      .bind(body.socialAccountId, hash)
      .first<{ id: string }>();
    if (dup) {
      return c.json({ error: 'duplicate post detected', existingPostId: dup.id }, 409);
    }
  }

  const id = crypto.randomUUID();
  const status = body.scheduledFor ? 'scheduled' : 'draft';

  await c.env.DB.prepare(
    `INSERT INTO posts (id, user_id, social_account_id, platform, content, media_key, media_type,
                        scheduled_for, status, caption_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  )
    .bind(
      id,
      user.uid,
      body.socialAccountId ?? null,
      body.platform,
      body.content,
      body.mediaKey ?? null,
      body.mediaType ?? null,
      body.scheduledFor ?? null,
      status,
      hash,
    )
    .run();

  const row = await getOwnedPostRow(c.env, id, user.uid);
  return c.json({ post: serializePost(row) }, 201);
});

// GET /posts/calendar — posts grouped by date for calendar view (must be before /posts/:id)
postsRoutes.get('/posts/calendar', async (c) => {
  const user = await requireUser(c);
  const month = c.req.query('month'); // YYYY-MM format
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return c.json({ error: 'month param required in YYYY-MM format' }, 400);
  }
  const startDate = `${month}-01`;
  const endMonth = parseInt(month.split('-')[1], 10);
  const endYear = parseInt(month.split('-')[0], 10);
  const nextMonth = endMonth === 12 ? `${endYear + 1}-01` : `${endYear}-${String(endMonth + 1).padStart(2, '0')}`;
  const endDate = `${nextMonth}-01`;

  const rows = await c.env.DB.prepare(
    `SELECT id, platform, content, status, scheduled_for, posted_at, social_account_id, created_at
     FROM posts WHERE user_id = ?
       AND (
         (scheduled_for IS NOT NULL AND scheduled_for >= ? AND scheduled_for < ?)
         OR (posted_at IS NOT NULL AND posted_at >= ? AND posted_at < ?)
         OR (scheduled_for IS NULL AND posted_at IS NULL AND created_at >= ? AND created_at < ?)
       )
     ORDER BY COALESCE(scheduled_for, posted_at, created_at) ASC`,
  )
    .bind(user.uid, startDate, endDate, startDate, endDate, startDate, endDate)
    .all<{ id: string; platform: string; content: string; status: string; scheduled_for: string | null; posted_at: string | null; social_account_id: string | null; created_at: string }>();

  return c.json({
    month,
    posts: rows.results.map(r => ({
      id: r.id,
      platform: r.platform,
      content: r.content.slice(0, 80),
      status: r.status,
      date: r.scheduled_for || r.posted_at || r.created_at,
      socialAccountId: r.social_account_id,
    })),
  });
});

// GET /posts/:id — get a single post
postsRoutes.get('/posts/:id', async (c) => {
  const user = await requireUser(c);
  const row = await getOwnedPostRow(c.env, c.req.param('id'), user.uid);
  return c.json({ post: serializePost(row) });
});

// PATCH /posts/:id — update a draft/scheduled post
postsRoutes.patch('/posts/:id', async (c) => {
  const user = await requireUser(c);
  const row = await getOwnedPostRow(c.env, c.req.param('id'), user.uid);
  if (row.status === 'posted' || row.status === 'posting') {
    throw new HttpError('cannot edit a post that has been published or is publishing', 409);
  }

  const body = await c.req.json<{
    content?: string;
    platform?: string;
    socialAccountId?: string;
    scheduledFor?: string | null;
    mediaKey?: string | null;
    mediaType?: string | null;
  }>();

  const content = body.content ?? row.content;
  const hash = body.content ? await captionHash(content) : row.caption_hash;
  const scheduledFor = body.scheduledFor !== undefined ? body.scheduledFor : row.scheduled_for;
  const status = scheduledFor ? 'scheduled' : 'draft';

  await c.env.DB.prepare(
    `UPDATE posts SET content = ?, platform = ?, social_account_id = ?, scheduled_for = ?,
            media_key = ?, media_type = ?, status = ?, caption_hash = ?, updated_at = datetime('now')
     WHERE id = ? AND user_id = ?`,
  )
    .bind(
      content,
      body.platform ?? row.platform,
      body.socialAccountId ?? row.social_account_id,
      scheduledFor,
      body.mediaKey !== undefined ? body.mediaKey : row.media_key,
      body.mediaType !== undefined ? body.mediaType : row.media_type,
      status,
      hash,
      row.id,
      user.uid,
    )
    .run();

  const updated = await getOwnedPostRow(c.env, row.id, user.uid);
  return c.json({ post: serializePost(updated) });
});

// DELETE /posts/:id — delete a draft/scheduled post
postsRoutes.delete('/posts/:id', async (c) => {
  const user = await requireUser(c);
  const row = await getOwnedPostRow(c.env, c.req.param('id'), user.uid);
  if (row.status === 'posted') {
    throw new HttpError('cannot delete a published post', 409);
  }

  await c.env.DB.prepare('DELETE FROM posts WHERE id = ? AND user_id = ?').bind(row.id, user.uid).run();
  return c.json({ ok: true });
});

// POST /posts/:id/publish — manually publish a post now
postsRoutes.post('/posts/:id/publish', async (c) => {
  const user = await requireUser(c);
  const post = await getOwnedPostRow(c.env, c.req.param('id'), user.uid);

  if (post.status === 'posted' && post.platform_post_id) {
    return c.json({ ok: true, alreadyPublished: true, platformPostId: post.platform_post_id });
  }
  if (post.status === 'posting') {
    throw new HttpError('post is currently being published', 409);
  }

  const body = await c.req
    .json<{ socialAccountId?: string; linkUrl?: string; mediaUrl?: string }>()
    .catch((): { socialAccountId?: string; linkUrl?: string; mediaUrl?: string } => ({}));

  const accountId = body.socialAccountId || post.social_account_id;
  if (!accountId) throw new HttpError('socialAccountId is required', 400);

  const account = await getOwnedSocialAccount(c.env, accountId, user.uid);

  // Rate limit check
  const rateCheck = await checkRateLimit(c.env, user.uid, post.platform);
  if (!rateCheck.allowed) {
    throw new HttpError(`daily rate limit reached for ${post.platform} (${rateCheck.limit}/day)`, 429);
  }

  // Mark as publishing
  await c.env.DB.prepare(
    "UPDATE posts SET status = 'posting', social_account_id = ?, updated_at = datetime('now') WHERE id = ?",
  )
    .bind(accountId, post.id)
    .run();

  try {
    const result = await publishStandalonePost(c.env, post, account, {
      linkUrl: body.linkUrl ?? null,
      mediaUrl: body.mediaUrl ?? null,
    });

    await incrementRateLimit(c.env, user.uid, post.platform);

    await c.env.DB.prepare(
      `UPDATE posts SET status = 'posted', platform_post_id = ?, posted_at = datetime('now'),
              error = NULL, updated_at = datetime('now') WHERE id = ?`,
    )
      .bind(result.externalPostId, post.id)
      .run();

    return c.json({ ok: true, platformPostId: result.externalPostId, permalink: result.permalink });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'publish failed';
    await c.env.DB.prepare(
      `UPDATE posts SET status = 'failed', error = ?, retry_count = retry_count + 1,
              updated_at = datetime('now') WHERE id = ?`,
    )
      .bind(message, post.id)
      .run();
    throw new HttpError(message, 502);
  }
});

// GET /dashboard — overview stats for the current user
postsRoutes.get('/dashboard', async (c) => {
  const user = await requireUser(c);

  const [accountsRow, postsRow, scheduledRow, recentRow] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) as count FROM social_accounts WHERE user_id = ? AND status = ?')
      .bind(user.uid, 'connected').first<{ count: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM posts WHERE user_id = ?')
      .bind(user.uid).first<{ count: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) as count FROM posts WHERE user_id = ? AND status = 'scheduled'")
      .bind(user.uid).first<{ count: number }>(),
    c.env.DB.prepare(
      `SELECT id, platform, content, status, scheduled_for, posted_at, created_at
       FROM posts WHERE user_id = ? ORDER BY COALESCE(posted_at, created_at) DESC LIMIT 5`,
    ).bind(user.uid).all<{ id: string; platform: string; content: string; status: string; scheduled_for: string | null; posted_at: string | null; created_at: string }>(),
  ]);

  return c.json({
    connectedAccounts: accountsRow?.count ?? 0,
    totalPosts: postsRow?.count ?? 0,
    scheduledPosts: scheduledRow?.count ?? 0,
    recentPosts: (recentRow?.results ?? []).map(r => ({
      id: r.id,
      platform: r.platform,
      content: r.content.slice(0, 120),
      status: r.status,
      scheduledFor: r.scheduled_for,
      postedAt: r.posted_at,
      createdAt: r.created_at,
    })),
  });
});

// GET /media/:key+ — serve uploaded media from R2 (used by platform APIs for image URLs)
postsRoutes.get('/media/:key{.+}', async (c) => {
  if (!c.env.MEDIA) throw new HttpError('media storage not configured', 503);
  const key = c.req.param('key');
  const object = await c.env.MEDIA.get(key);
  if (!object) throw new HttpError('media not found', 404);

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=86400');
  return new Response(object.body, { headers });
});

// POST /posts/batch-schedule — approve + auto-schedule multiple draft posts
postsRoutes.post('/posts/batch-schedule', async (c) => {
  const user = await requireUser(c);
  const body = await c.req.json<{
    postIds: string[];
    socialAccountId: string;
    startDate?: string;
    postsPerDay?: number;
  }>();

  if (!body.postIds?.length) return c.json({ error: 'postIds required' }, 400);
  if (!body.socialAccountId) return c.json({ error: 'socialAccountId required' }, 400);

  // Verify the social account belongs to this user
  await getOwnedSocialAccount(c.env, body.socialAccountId, user.uid);

  const postsPerDay = Math.min(body.postsPerDay || 3, 10);
  const start = body.startDate ? new Date(body.startDate) : new Date(Date.now() + 3600_000); // default: 1h from now

  // Optimal posting times per slot (hour:minute in UTC)
  const slots = [
    [9, 0], [12, 30], [17, 0],   // 3/day
    [8, 0], [10, 30], [13, 0], [16, 0], [19, 0],  // 5/day
    [7, 0], [8, 30], [10, 0], [11, 30], [13, 0], [14, 30], [16, 0], [17, 30], [19, 0], [20, 30], // 10/day
  ];
  const daySlots = slots.slice(0, postsPerDay);

  let scheduled = 0;
  let dayOffset = 0;
  let slotIdx = 0;

  for (const postId of body.postIds) {
    const row = await c.env.DB.prepare(
      "SELECT id, status FROM posts WHERE id = ? AND user_id = ? AND status = 'draft'",
    ).bind(postId, user.uid).first<{ id: string; status: string }>();

    if (!row) continue; // skip non-draft or not-owned

    const scheduleDate = new Date(start);
    scheduleDate.setDate(scheduleDate.getDate() + dayOffset);
    scheduleDate.setHours(daySlots[slotIdx][0], daySlots[slotIdx][1], 0, 0);

    await c.env.DB.prepare(
      `UPDATE posts SET status = 'scheduled', social_account_id = ?, scheduled_for = ?,
              updated_at = datetime('now') WHERE id = ?`,
    ).bind(body.socialAccountId, scheduleDate.toISOString(), row.id).run();

    scheduled++;
    slotIdx++;
    if (slotIdx >= daySlots.length) {
      slotIdx = 0;
      dayOffset++;
    }
  }

  return c.json({ scheduled, totalDays: dayOffset + 1 });
});

// POST /posts/upload-media — upload media to R2
postsRoutes.post('/posts/upload-media', async (c) => {
  const user = await requireUser(c);
  if (!c.env.MEDIA) throw new HttpError('media storage not configured', 503);

  const contentType = c.req.header('Content-Type') || 'application/octet-stream';
  const ext = contentType.includes('video') ? 'mp4' : contentType.includes('png') ? 'png' : 'jpg';
  const key = `${user.uid}/${crypto.randomUUID()}.${ext}`;

  const body = await c.req.arrayBuffer();
  if (body.byteLength > 50 * 1024 * 1024) {
    throw new HttpError('file too large (max 50 MB)', 413);
  }

  await c.env.MEDIA.put(key, body, { httpMetadata: { contentType } });

  return c.json({ key, size: body.byteLength, contentType }, 201);
});

async function publishStandalonePost(
  env: Env,
  post: PostRow,
  account: SocialAccountRow,
  options: { linkUrl: string | null; mediaUrl: string | null },
): Promise<{ externalPostId: string; permalink: string | null }> {
  let accessToken: string;

  // Auto-refresh expired X tokens before publishing
  if (
    account.provider === 'x' &&
    account.refresh_token_encrypted &&
    account.refresh_token_iv &&
    account.token_expires_at &&
    Date.parse(account.token_expires_at) < Date.now() + 5 * 60 * 1000 // expires within 5 min
  ) {
    try {
      const refreshed = await refreshXToken(env, {
        id: account.id,
        refresh_token_encrypted: account.refresh_token_encrypted,
        refresh_token_iv: account.refresh_token_iv,
      });
      accessToken = refreshed.accessToken;
    } catch {
      // If refresh fails, try with the existing token anyway
      accessToken = await decryptSecret(account.access_token_encrypted, account.access_token_iv, requireSocialTokenKey(env));
    }
  } else {
    accessToken = await decryptSecret(account.access_token_encrypted, account.access_token_iv, requireSocialTokenKey(env));
  }

  const supportedProviders = ['facebook', 'instagram', 'x'] as const;
  type Supported = (typeof supportedProviders)[number];
  if (!supportedProviders.includes(account.provider as Supported)) {
    throw new HttpError(`publishing to ${account.provider} is not yet supported`, 409);
  }
  const provider = account.provider as Supported;

  const accountRef = {
    id: account.id,
    provider,
    accountId: account.account_id,
    pageId: account.page_id,
    displayName: account.display_name,
    accessToken,
  };

  const postType = post.media_key || options.mediaUrl ? 'image' as const
    : options.linkUrl ? 'link' as const
    : 'text' as const;

  const input = {
    postId: post.id,
    provider,
    account: accountRef,
    postType,
    body: post.content,
    mediaUrl: options.mediaUrl ?? null,
    linkUrl: options.linkUrl ?? null,
    idempotencyKey: post.id,
  };

  if (provider === 'x') {
    const adapter = new XAdapter();
    const result = await adapter.publish(input);
    return { externalPostId: result.externalPostId, permalink: result.externalPermalink ?? null };
  }

  // Meta (Facebook/Instagram)
  const adapter = new MetaOrganicAdapter(metaGraph(env));
  const result = await adapter.publish(input);
  return { externalPostId: result.externalPostId, permalink: result.externalPermalink ?? null };
}

// Used by the scheduled publisher cron
export async function publishDueStandalonePosts(
  env: Env,
  limit = 10,
): Promise<{ attempted: number; published: number; failed: number }> {
  const rows = await env.DB.prepare(
    `SELECT id, user_id, social_account_id, campaign_id, source_content_id, platform, content, media_key, media_type,
            scheduled_for, posted_at, platform_post_id, status, error, retry_count, caption_hash,
            created_at, updated_at
     FROM posts
     WHERE status = 'scheduled'
       AND social_account_id IS NOT NULL
       AND (scheduled_for IS NULL OR datetime(scheduled_for) <= datetime('now'))
     ORDER BY scheduled_for ASC
     LIMIT ?`,
  )
    .bind(limit)
    .all<PostRow>();

  let published = 0;
  let failed = 0;

  for (const post of rows.results) {
    try {
      const account = await getOwnedSocialAccount(env, post.social_account_id as string, post.user_id);

      const rateCheck = await checkRateLimit(env, post.user_id, post.platform);
      if (!rateCheck.allowed) {
        console.warn(`rate limit hit for ${post.user_id}/${post.platform}, skipping post ${post.id}`);
        continue;
      }

      await env.DB.prepare(
        "UPDATE posts SET status = 'posting', updated_at = datetime('now') WHERE id = ?",
      ).bind(post.id).run();

      const result = await publishStandalonePost(env, post, account, {
        linkUrl: null,
        mediaUrl: post.media_key?.startsWith('http') ? post.media_key : null,
      });

      await incrementRateLimit(env, post.user_id, post.platform);

      await env.DB.prepare(
        `UPDATE posts SET status = 'posted', platform_post_id = ?, posted_at = datetime('now'),
                error = NULL, updated_at = datetime('now') WHERE id = ?`,
      )
        .bind(result.externalPostId, post.id)
        .run();
      published++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : 'publish failed';
      await env.DB.prepare(
        `UPDATE posts SET status = 'failed', error = ?, retry_count = retry_count + 1,
                updated_at = datetime('now') WHERE id = ?`,
      )
        .bind(message, post.id)
        .run();
      console.error('scheduled standalone publish failed', post.id, err);
    }
  }

  return { attempted: rows.results.length, published, failed };
}
