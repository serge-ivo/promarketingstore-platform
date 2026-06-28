import type { Context, Hono } from 'hono';
import { HttpError, requireUser } from './auth.js';
import { decryptSecret, encryptSecret } from './secret-crypto.js';
import { requireSocialTokenKey } from './social-meta.js';
import type { Env } from './types.js';

type AppEnv = { Bindings: Env };
type RouteContext = Context<AppEnv>;

const X_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access'];

function requireXConfig(env: Env): { clientId: string; clientSecret: string; redirectUri: string } {
  if (!env.X_CLIENT_ID) throw new HttpError('X_CLIENT_ID is not configured', 503);
  if (!env.X_CLIENT_SECRET) throw new HttpError('X_CLIENT_SECRET is not configured', 503);
  const redirectUri = env.X_REDIRECT_URI || `${env.CORS_ORIGIN.replace(/\/$/, '')}/v1/social/x/oauth/callback`;
  return { clientId: env.X_CLIENT_ID, clientSecret: env.X_CLIENT_SECRET, redirectUri };
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64url(new Uint8Array(hash));
  return { verifier, challenge };
}

async function startXOAuth(c: RouteContext): Promise<Response> {
  const user = await requireUser(c);
  const { clientId, redirectUri } = requireXConfig(c.env);
  const body = await c.req.json<{ returnTo?: string }>().catch((): { returnTo?: string } => ({}));

  const state = crypto.randomUUID();
  const pkce = await generatePkce();
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const returnTo = safeReturnTo(c.env, body.returnTo);

  await c.env.DB.prepare(
    `INSERT INTO oauth_states (id, user_id, provider, return_to, metadata, created_at, expires_at)
     VALUES (?, ?, 'x', ?, ?, datetime('now'), ?)`,
  )
    .bind(state, user.uid, returnTo, JSON.stringify({ code_verifier: pkce.verifier }), expires)
    .run();

  const url = new URL('https://x.com/i/oauth2/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', X_SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  return c.json({ authUrl: url.toString(), state, expiresAt: expires });
}

async function completeXOAuth(c: RouteContext): Promise<Response> {
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state) return c.json({ error: 'missing code or state' }, 400);

  const stored = await c.env.DB.prepare(
    `SELECT id, user_id, return_to, metadata, expires_at FROM oauth_states
     WHERE id = ? AND provider = 'x'`,
  ).bind(state).first<{ id: string; user_id: string; return_to: string | null; metadata: string | null; expires_at: string }>();

  if (!stored) return c.json({ error: 'invalid oauth state' }, 400);
  if (Date.parse(stored.expires_at) < Date.now()) return c.json({ error: 'oauth state expired' }, 400);

  const meta = JSON.parse(stored.metadata || '{}') as { code_verifier?: string };
  if (!meta.code_verifier) return c.json({ error: 'missing PKCE verifier' }, 400);

  const { clientId, clientSecret, redirectUri } = requireXConfig(c.env);

  // Exchange code for tokens
  const tokenRes = await fetch('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: meta.code_verifier,
    }),
  });
  const tokenBody = (await tokenRes.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!tokenRes.ok || !tokenBody.access_token) {
    throw new HttpError(tokenBody.error_description ?? 'failed to exchange X OAuth code', 502);
  }

  // Fetch user profile
  const profileRes = await fetch('https://api.x.com/2/users/me?user.fields=id,name,username,profile_image_url', {
    headers: { Authorization: `Bearer ${tokenBody.access_token}` },
  });
  const profileBody = (await profileRes.json().catch(() => ({}))) as {
    data?: { id: string; name: string; username: string };
  };
  if (!profileBody.data?.id) {
    throw new HttpError('failed to fetch X user profile', 502);
  }

  const tokenKey = requireSocialTokenKey(c.env);
  const encryptedAccess = await encryptSecret(tokenBody.access_token, tokenKey);
  const encryptedRefresh = tokenBody.refresh_token
    ? await encryptSecret(tokenBody.refresh_token, tokenKey)
    : null;

  await c.env.DB.prepare(
    `INSERT INTO social_accounts
       (id, user_id, provider, account_id, page_id, display_name, access_token_encrypted, access_token_iv,
        refresh_token_encrypted, refresh_token_iv, scopes, token_expires_at, status, created_at, updated_at)
     VALUES (?, ?, 'x', ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'connected', datetime('now'), datetime('now'))
     ON CONFLICT(user_id, provider, account_id) DO UPDATE SET
       display_name = excluded.display_name,
       access_token_encrypted = excluded.access_token_encrypted,
       access_token_iv = excluded.access_token_iv,
       refresh_token_encrypted = excluded.refresh_token_encrypted,
       refresh_token_iv = excluded.refresh_token_iv,
       scopes = excluded.scopes,
       token_expires_at = excluded.token_expires_at,
       status = 'connected',
       updated_at = datetime('now')`,
  )
    .bind(
      crypto.randomUUID(),
      stored.user_id,
      profileBody.data.id,
      `@${profileBody.data.username}`,
      encryptedAccess.ciphertext,
      encryptedAccess.iv,
      encryptedRefresh?.ciphertext ?? null,
      encryptedRefresh?.iv ?? null,
      JSON.stringify(X_SCOPES),
      tokenBody.expires_in ? new Date(Date.now() + tokenBody.expires_in * 1000).toISOString() : null,
    )
    .run();

  await c.env.DB.prepare('DELETE FROM oauth_states WHERE id = ?').bind(state).run();

  const returnTo = new URL(stored.return_to || safeReturnTo(c.env, undefined));
  returnTo.searchParams.set('social', 'connected');
  returnTo.searchParams.set('provider', 'x');
  returnTo.searchParams.set('username', profileBody.data.username);
  return c.redirect(returnTo.toString(), 302);
}

function safeReturnTo(env: Env, value: string | undefined): string {
  const fallback = `${env.CORS_ORIGIN.replace(/\/$/, '')}/console/`;
  if (!value) return fallback;
  try {
    const url = new URL(value, env.CORS_ORIGIN);
    const allowed = new URL(env.CORS_ORIGIN);
    if (url.origin !== allowed.origin) return fallback;
    return url.toString();
  } catch {
    return fallback;
  }
}

/** Refresh an X access token using the stored refresh token. X uses rotation — each refresh returns a new refresh_token. */
export async function refreshXToken(
  env: Env,
  account: { id: string; refresh_token_encrypted: string; refresh_token_iv: string },
): Promise<{ accessToken: string; expiresAt: string | null }> {
  const { clientId, clientSecret } = requireXConfig(env);
  const tokenKey = requireSocialTokenKey(env);
  const refreshToken = await decryptSecret(account.refresh_token_encrypted, account.refresh_token_iv, tokenKey);

  const res = await fetch('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(body.error_description ?? 'X token refresh failed');
  }

  const encryptedAccess = await encryptSecret(body.access_token, tokenKey);
  const encryptedRefresh = body.refresh_token ? await encryptSecret(body.refresh_token, tokenKey) : null;
  const expiresAt = body.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : null;

  await env.DB.prepare(
    `UPDATE social_accounts SET
       access_token_encrypted = ?, access_token_iv = ?,
       refresh_token_encrypted = COALESCE(?, refresh_token_encrypted),
       refresh_token_iv = COALESCE(?, refresh_token_iv),
       token_expires_at = ?, status = 'connected', updated_at = datetime('now')
     WHERE id = ?`,
  )
    .bind(
      encryptedAccess.ciphertext,
      encryptedAccess.iv,
      encryptedRefresh?.ciphertext ?? null,
      encryptedRefresh?.iv ?? null,
      expiresAt,
      account.id,
    )
    .run();

  return { accessToken: body.access_token, expiresAt };
}

/** Cron job: refresh tokens expiring within 30 minutes. */
export async function refreshExpiringXTokens(env: Env): Promise<{ refreshed: number; failed: number }> {
  const cutoff = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const rows = await env.DB.prepare(
    `SELECT id, refresh_token_encrypted, refresh_token_iv FROM social_accounts
     WHERE provider = 'x' AND status = 'connected'
       AND refresh_token_encrypted IS NOT NULL
       AND token_expires_at IS NOT NULL AND datetime(token_expires_at) <= datetime(?)`,
  )
    .bind(cutoff)
    .all<{ id: string; refresh_token_encrypted: string; refresh_token_iv: string }>();

  let refreshed = 0;
  let failed = 0;
  for (const row of rows.results) {
    try {
      await refreshXToken(env, row);
      refreshed++;
    } catch (err) {
      failed++;
      console.error(`X token refresh failed for account ${row.id}:`, err);
      await env.DB.prepare(
        "UPDATE social_accounts SET status = 'expired', updated_at = datetime('now') WHERE id = ?",
      ).bind(row.id).run();
    }
  }
  return { refreshed, failed };
}

export function registerXOAuthRoutes(routes: Hono<AppEnv>) {
  routes.post('/social/x/oauth/start', startXOAuth);
  routes.get('/social/x/oauth/callback', completeXOAuth);
}
