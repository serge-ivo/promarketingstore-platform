import type { SocialProvider } from '@pms/social';
import type { Context, Hono } from 'hono';
import { HttpError, requireUser } from './auth.js';
import { encryptSecret } from './secret-crypto.js';
import type { Env } from './types.js';

type AppEnv = { Bindings: Env };

const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'instagram_basic',
  'instagram_content_publish',
];

interface MetaPage {
  id: string;
  name?: string;
  access_token?: string;
  instagram_business_account?: {
    id: string;
    username?: string;
    name?: string;
  };
}

interface OAuthStateRow {
  id: string;
  user_id: string;
  return_to: string | null;
  expires_at: string;
}

interface MetaTokenBody {
  access_token?: string;
  expires_in?: number;
  error?: { message?: string };
}

type RouteContext = Context<AppEnv>;

function metaVersion(env: Env): string {
  return env.META_GRAPH_VERSION || 'v25.0';
}

export function metaGraph(env: Env): string {
  return `https://graph.facebook.com/${metaVersion(env)}`;
}

function metaDialog(env: Env): string {
  return `https://www.facebook.com/${metaVersion(env)}/dialog/oauth`;
}

function metaRedirectUri(env: Env): string {
  return env.META_REDIRECT_URI || `${env.CORS_ORIGIN.replace(/\/$/, '')}/v1/social/meta/oauth/callback`;
}

function requireMetaConfig(env: Env): { appId: string; appSecret: string; redirectUri: string } {
  if (!env.META_APP_ID) throw new HttpError('META_APP_ID is not configured', 503);
  if (!env.META_APP_SECRET) throw new HttpError('META_APP_SECRET is not configured', 503);
  return { appId: env.META_APP_ID, appSecret: env.META_APP_SECRET, redirectUri: metaRedirectUri(env) };
}

export function requireSocialTokenKey(env: Env): string {
  if (!env.SOCIAL_TOKEN_ENCRYPTION_KEY) {
    throw new HttpError('SOCIAL_TOKEN_ENCRYPTION_KEY is not configured', 503);
  }
  return env.SOCIAL_TOKEN_ENCRYPTION_KEY;
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

async function upsertSocialAccount(
  env: Env,
  input: {
    userId: string;
    provider: SocialProvider;
    accountId: string;
    pageId?: string | null;
    displayName: string;
    accessToken: string;
    scopes: string[];
    tokenExpiresAt?: string | null;
  },
) {
  const encrypted = await encryptSecret(input.accessToken, requireSocialTokenKey(env));
  await env.DB.prepare(
    `INSERT INTO social_accounts
       (id, user_id, provider, account_id, page_id, display_name, access_token_encrypted, access_token_iv,
        scopes, token_expires_at, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', datetime('now'), datetime('now'))
     ON CONFLICT(user_id, provider, account_id) DO UPDATE SET
       page_id = excluded.page_id,
       display_name = excluded.display_name,
       access_token_encrypted = excluded.access_token_encrypted,
       access_token_iv = excluded.access_token_iv,
       scopes = excluded.scopes,
       token_expires_at = excluded.token_expires_at,
       status = 'connected',
       updated_at = datetime('now')`,
  )
    .bind(
      crypto.randomUUID(),
      input.userId,
      input.provider,
      input.accountId,
      input.pageId ?? null,
      input.displayName,
      encrypted.ciphertext,
      encrypted.iv,
      JSON.stringify(input.scopes),
      input.tokenExpiresAt ?? null,
    )
    .run();
}

async function loadOAuthState(env: Env, state: string): Promise<OAuthStateRow | null> {
  return env.DB.prepare(
    `SELECT id, user_id, return_to, expires_at FROM oauth_states
     WHERE id = ? AND provider = 'meta'`,
  )
    .bind(state)
    .first<OAuthStateRow>();
}

async function exchangeMetaCode(env: Env, code: string): Promise<MetaTokenBody> {
  const { appId, appSecret, redirectUri } = requireMetaConfig(env);
  const tokenUrl = new URL(`${metaGraph(env)}/oauth/access_token`);
  tokenUrl.searchParams.set('client_id', appId);
  tokenUrl.searchParams.set('client_secret', appSecret);
  tokenUrl.searchParams.set('redirect_uri', redirectUri);
  tokenUrl.searchParams.set('code', code);

  const tokenResponse = await fetch(tokenUrl);
  const tokenBody = (await tokenResponse.json().catch(() => ({}))) as MetaTokenBody;
  if (!tokenResponse.ok || !tokenBody.access_token) {
    throw new HttpError(tokenBody.error?.message ?? 'failed to exchange Meta OAuth code', 502);
  }
  return tokenBody;
}

async function listMetaPages(env: Env, accessToken: string): Promise<MetaPage[]> {
  const pagesUrl = new URL(`${metaGraph(env)}/me/accounts`);
  pagesUrl.searchParams.set('fields', 'id,name,access_token,instagram_business_account{id,username,name}');
  pagesUrl.searchParams.set('access_token', accessToken);

  const pagesResponse = await fetch(pagesUrl);
  const pagesBody = (await pagesResponse.json().catch(() => ({}))) as {
    data?: MetaPage[];
    error?: { message?: string };
  };
  if (!pagesResponse.ok) {
    throw new HttpError(pagesBody.error?.message ?? 'failed to list Facebook Pages', 502);
  }
  return pagesBody.data ?? [];
}

async function connectMetaPages(
  env: Env,
  input: {
    userId: string;
    pages: MetaPage[];
    tokenExpiresAt: string | null;
  },
): Promise<number> {
  let connected = 0;

  for (const page of input.pages) {
    if (!page.id || !page.access_token) continue;
    await upsertSocialAccount(env, {
      userId: input.userId,
      provider: 'facebook',
      accountId: page.id,
      displayName: page.name ?? `Facebook Page ${page.id}`,
      accessToken: page.access_token,
      scopes: META_SCOPES,
      tokenExpiresAt: input.tokenExpiresAt,
    });
    connected++;

    const ig = page.instagram_business_account;
    if (ig?.id) {
      await upsertSocialAccount(env, {
        userId: input.userId,
        provider: 'instagram',
        accountId: ig.id,
        pageId: page.id,
        displayName: ig.username ? `@${ig.username}` : (ig.name ?? `Instagram ${ig.id}`),
        accessToken: page.access_token,
        scopes: META_SCOPES,
        tokenExpiresAt: input.tokenExpiresAt,
      });
      connected++;
    }
  }

  return connected;
}

async function startMetaOAuth(c: RouteContext): Promise<Response> {
  const user = await requireUser(c);
  const { appId, redirectUri } = requireMetaConfig(c.env);
  const body = await c.req.json<{ returnTo?: string }>().catch((): { returnTo?: string } => ({}));
  const state = crypto.randomUUID();
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const returnTo = safeReturnTo(c.env, body.returnTo);

  await c.env.DB.prepare(
    `INSERT INTO oauth_states (id, user_id, provider, return_to, created_at, expires_at)
       VALUES (?, ?, 'meta', ?, datetime('now'), ?)`,
  )
    .bind(state, user.uid, returnTo, expires)
    .run();

  const url = new URL(metaDialog(c.env));
  url.searchParams.set('client_id', appId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', META_SCOPES.join(','));

  return c.json({ authUrl: url.toString(), state, expiresAt: expires });
}

async function completeMetaOAuth(c: RouteContext): Promise<Response> {
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state) return c.json({ error: 'missing code or state' }, 400);

  const stored = await loadOAuthState(c.env, state);
  if (!stored) return c.json({ error: 'invalid oauth state' }, 400);
  if (Date.parse(stored.expires_at) < Date.now()) return c.json({ error: 'oauth state expired' }, 400);

  const tokenBody = await exchangeMetaCode(c.env, code);
  const pages = await listMetaPages(c.env, tokenBody.access_token as string);
  const tokenExpiresAt = tokenBody.expires_in ? new Date(Date.now() + tokenBody.expires_in * 1000).toISOString() : null;
  const connected = await connectMetaPages(c.env, { userId: stored.user_id, pages, tokenExpiresAt });

  await c.env.DB.prepare('DELETE FROM oauth_states WHERE id = ?').bind(state).run();
  const returnTo = new URL(stored.return_to || safeReturnTo(c.env, undefined));
  returnTo.searchParams.set('social', 'connected');
  returnTo.searchParams.set('accounts', String(connected));
  return c.redirect(returnTo.toString(), 302);
}

/** Refresh a long-lived Meta token (60-day → new 60-day). */
async function refreshMetaToken(
  env: Env,
  account: { id: string; access_token_encrypted: string; access_token_iv: string },
): Promise<void> {
  const { decryptSecret } = await import('./secret-crypto.js');
  const tokenKey = requireSocialTokenKey(env);
  const currentToken = await decryptSecret(account.access_token_encrypted, account.access_token_iv, tokenKey);
  const { appId, appSecret } = requireMetaConfig(env);

  const url = new URL(`${metaGraph(env)}/oauth/access_token`);
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('fb_exchange_token', currentToken);

  const res = await fetch(url);
  const body = (await res.json().catch(() => ({}))) as MetaTokenBody;
  if (!res.ok || !body.access_token) {
    throw new Error(body.error?.message ?? 'Meta token refresh failed');
  }

  const { encryptSecret } = await import('./secret-crypto.js');
  const encrypted = await encryptSecret(body.access_token, tokenKey);
  const expiresAt = body.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : null;

  await env.DB.prepare(
    `UPDATE social_accounts SET access_token_encrypted = ?, access_token_iv = ?,
            token_expires_at = ?, status = 'connected', updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(encrypted.ciphertext, encrypted.iv, expiresAt, account.id)
    .run();
}

/** Cron job: refresh Meta tokens expiring within 7 days. */
export async function refreshExpiringMetaTokens(env: Env): Promise<{ refreshed: number; failed: number }> {
  if (!env.META_APP_ID || !env.META_APP_SECRET) return { refreshed: 0, failed: 0 };

  const cutoff = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await env.DB.prepare(
    `SELECT id, access_token_encrypted, access_token_iv FROM social_accounts
     WHERE provider IN ('facebook', 'instagram') AND status = 'connected'
       AND token_expires_at IS NOT NULL AND datetime(token_expires_at) <= datetime(?)`,
  )
    .bind(cutoff)
    .all<{ id: string; access_token_encrypted: string; access_token_iv: string }>();

  let refreshed = 0;
  let failed = 0;
  for (const row of rows.results) {
    try {
      await refreshMetaToken(env, row);
      refreshed++;
    } catch (err) {
      failed++;
      console.error(`Meta token refresh failed for account ${row.id}:`, err);
      await env.DB.prepare(
        "UPDATE social_accounts SET status = 'expired', updated_at = datetime('now') WHERE id = ?",
      ).bind(row.id).run();
    }
  }
  return { refreshed, failed };
}

export function registerMetaOAuthRoutes(routes: Hono<AppEnv>) {
  routes.post('/social/meta/oauth/start', startMetaOAuth);
  routes.get('/social/meta/oauth/callback', completeMetaOAuth);
}
