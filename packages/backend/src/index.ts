import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createSession, exchangeGoogleCode, HttpError, verifySession } from './auth.js';
import { brainRoutes } from './brain.js';
import { campaignRoutes } from './campaigns.js';
import { keysRoutes } from './keys.js';
import { brandRoutes, loadBrandVoice } from './brand.js';
import { generatePosts } from './generator.js';
import { onboardRoutes } from './onboard.js';
import { postsRoutes, publishDueStandalonePosts } from './posts.js';
import { publishDuePosts } from './scheduled-publisher.js';
import { socialRoutes } from './social.js';
import { sourcesRoutes } from './sources.js';
import { webhookRoutes } from './webhooks.js';
import { refreshExpiringMetaTokens } from './social-meta.js';
import { refreshExpiringXTokens } from './social-x.js';
import type { Env } from './types.js';

export const app = new Hono<{ Bindings: Env }>();

// ── CORS ─────────────────────────────────────────────────────────────

function corsOrigin(origin: string | undefined, env: Env): string | null {
  if (!origin) return null;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') return origin;
    if (host.endsWith('.promarketingstore.online') || host === 'promarketingstore.online') return origin;
    if (host.endsWith('.pages.dev') && host.includes('promarketingstore')) return origin;
    if (origin === env.CORS_ORIGIN) return origin;
    return null;
  } catch {
    return null;
  }
}

app.use('*', async (c, next) => {
  const handler = cors({
    origin: (origin) => corsOrigin(origin, c.env),
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  });
  return handler(c, next);
});

// ── Security headers ─────────────────────────────────────────────────

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
});

// ── Error handler ────────────────────────────────────────────────────

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message }, err.status as 401);
  }
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

// ── Health ───────────────────────────────────────────────────────────

app.get('/', (c) => c.json({ ok: true, service: 'promarketingstore-api' }));
app.get('/health', (c) => c.json({ ok: true }));

// ── v1 routes ────────────────────────────────────────────────────────

const v1 = new Hono<{ Bindings: Env }>();

// POST /v1/auth/google — exchange Google OAuth code for session
v1.post('/auth/google', async (c) => {
  const body = await c.req.json<{ code: string }>();
  if (!body.code) return c.json({ error: 'missing code' }, 400);

  const profile = await exchangeGoogleCode(body.code, c.env);
  if (!profile?.email) {
    return c.json({ error: 'failed to exchange code' }, 401);
  }

  const userId = `google:${profile.sub}`;
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO users (id, email, name, avatar_url, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       email = excluded.email,
       name = excluded.name,
       avatar_url = excluded.avatar_url`,
  )
    .bind(userId, profile.email, profile.name ?? null, profile.picture ?? null, now)
    .run();

  const token = await createSession(
    { uid: userId, email: profile.email, name: profile.name, avatarUrl: profile.picture },
    c.env.SESSION_SIGNING_KEY,
  );

  return c.json({
    token,
    user: {
      id: userId,
      email: profile.email,
      name: profile.name ?? null,
      avatarUrl: profile.picture ?? null,
    },
  });
});

// GET /v1/auth/me — get current user
v1.get('/auth/me', async (c) => {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'missing bearer token' }, 401);
  }
  const claims = await verifySession(header.slice(7), c.env.SESSION_SIGNING_KEY);
  if (!claims) {
    return c.json({ error: 'invalid or expired session' }, 401);
  }
  return c.json({
    id: claims.uid,
    email: claims.email,
    name: claims.name ?? null,
    avatarUrl: claims.avatarUrl ?? null,
  });
});

// POST /v1/auth/logout — logout (no-op, JWT-based, client clears token)
v1.post('/auth/logout', (c) => {
  return c.json({ ok: true });
});

// Key vault + campaign + social + posts + sources routes
v1.route('/', keysRoutes);
v1.route('/', campaignRoutes);
v1.route('/', brainRoutes);
v1.route('/', socialRoutes);
v1.route('/', postsRoutes);
v1.route('/', sourcesRoutes);
v1.route('/', brandRoutes);
v1.route('/', onboardRoutes);
v1.route('/', webhookRoutes);

app.route('/v1', v1);

async function scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  if (event.cron === '* * * * *') {
    // Every minute: publish due posts + retry failed posts (max 3 retries)
    await Promise.allSettled([
      publishDuePosts(env).catch(err => console.error('publishDuePosts failed:', err)),
      publishDueStandalonePosts(env).catch(err => console.error('publishDueStandalonePosts failed:', err)),
      retryFailedPosts(env).catch(err => console.error('retryFailedPosts failed:', err)),
    ]);
  }
  if (event.cron === '0 3 * * *') {
    // Daily 3am: refresh tokens + scan sources + auto-generate
    const [xResult, metaResult] = await Promise.all([
      refreshExpiringXTokens(env),
      refreshExpiringMetaTokens(env),
    ]);
    console.log('daily token refresh:', { x: xResult, meta: metaResult });

    // Scan sources with daily frequency
    const { scanSource } = await import('./scanner.js');
    const sources = await env.DB.prepare(
      "SELECT * FROM sources WHERE status = 'active' AND scan_frequency = 'daily'",
    ).all<{ id: string; user_id: string; type: string; config: string }>();

    for (const source of sources.results) {
      try {
        const result = await scanSource(env, source);
        await env.DB.prepare(
          "UPDATE sources SET last_scanned_at = datetime('now') WHERE id = ?",
        ).bind(source.id).run();

        // Auto-generate if new content was found and user has auto-approve enabled
        if (result.extracted > 0) {
          await autoGenerateForSource(env, source);
        }
      } catch (err) {
        console.error(`source scan failed ${source.id}:`, err);
      }
    }
  }
}

/** Retry posts that failed with retry_count < 3, backing off 5 min per retry. */
async function retryFailedPosts(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // at least 5 min old
  const rows = await env.DB.prepare(
    `SELECT id FROM posts
     WHERE status = 'failed' AND retry_count < 3 AND social_account_id IS NOT NULL
       AND updated_at <= ?
     LIMIT 5`,
  ).bind(cutoff).all<{ id: string }>();

  for (const row of rows.results) {
    await env.DB.prepare(
      "UPDATE posts SET status = 'scheduled', error = NULL, updated_at = datetime('now') WHERE id = ?",
    ).bind(row.id).run();
  }
}

/** Auto-generate posts from newly scanned source content if user has auto-approve enabled. */
async function autoGenerateForSource(
  env: Env,
  source: { id: string; user_id: string },
): Promise<void> {
  // Check if user has auto-approve enabled
  const brand = await env.DB.prepare(
    'SELECT approval_rules_json FROM brand_profiles WHERE user_id = ? LIMIT 1',
  ).bind(source.user_id).first<{ approval_rules_json: string }>();

  if (!brand) return;
  const rules = JSON.parse(brand.approval_rules_json) as { autoApprove?: boolean; postsPerDay?: number };
  if (!rules.autoApprove) return;

  // Get recent unprocessed content
  const content = await env.DB.prepare(
    `SELECT sc.id, sc.title, sc.body, sc.url FROM source_content sc
     LEFT JOIN posts p ON p.source_content_id = sc.id
     WHERE sc.source_id = ? AND p.id IS NULL
     ORDER BY sc.extracted_at DESC LIMIT 5`,
  ).bind(source.id).all<{ id: string; title: string | null; body: string; url: string | null }>();

  if (!content.results.length) return;

  const brandVoice = await loadBrandVoice(env, source.user_id);
  const platforms = ['x', 'facebook']; // default platforms for auto-generate

  try {
    const posts = await generatePosts(env, {
      userId: source.user_id,
      sourceContent: content.results,
      platforms,
      count: Math.min(rules.postsPerDay || 3, 10),
      tone: brandVoice?.tone || 'professional',
      brandVoice: brandVoice ?? undefined,
    });

    // Auto-schedule the generated posts
    if (posts.length > 0) {
      // Find a connected social account
      const account = await env.DB.prepare(
        "SELECT id FROM social_accounts WHERE user_id = ? AND status = 'connected' LIMIT 1",
      ).bind(source.user_id).first<{ id: string }>();

      if (account) {
        const postsPerDay = rules.postsPerDay || 3;
        const slots = [[9, 0], [12, 30], [17, 0], [8, 0], [10, 30], [13, 0], [16, 0], [19, 0]];
        const daySlots = slots.slice(0, postsPerDay);
        let dayOffset = 0;
        let slotIdx = 0;
        const start = new Date();
        start.setDate(start.getDate() + 1); // start tomorrow

        for (const post of posts) {
          const scheduleDate = new Date(start);
          scheduleDate.setDate(scheduleDate.getDate() + dayOffset);
          scheduleDate.setHours(daySlots[slotIdx][0], daySlots[slotIdx][1], 0, 0);

          await env.DB.prepare(
            `UPDATE posts SET status = 'scheduled', social_account_id = ?, scheduled_for = ?,
                    updated_at = datetime('now') WHERE id = ?`,
          ).bind(account.id, scheduleDate.toISOString(), post.id).run();

          slotIdx++;
          if (slotIdx >= daySlots.length) { slotIdx = 0; dayOffset++; }
        }
        console.log(`auto-generated ${posts.length} posts for source ${source.id}, scheduled across ${dayOffset + 1} days`);
      }
    }
  } catch (err) {
    console.error(`auto-generate failed for source ${source.id}:`, err);
  }
}

export default {
  fetch: app.fetch,
  scheduled,
};
