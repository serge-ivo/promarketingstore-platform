import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HttpError, createSession, verifySession, exchangeGoogleCode } from './auth.js';
import { keysRoutes } from './keys.js';
import { campaignRoutes } from './campaigns.js';
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

app.use(
  '*',
  async (c, next) => {
    const handler = cors({
      origin: (origin) => corsOrigin(origin, c.env),
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type'],
      maxAge: 600,
    });
    return handler(c, next);
  },
);

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
  if (!profile || !profile.email) {
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

// Key vault + campaign routes
v1.route('/', keysRoutes);
v1.route('/', campaignRoutes);

app.route('/v1', v1);

export default app;
