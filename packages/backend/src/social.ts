import { Hono } from 'hono';
import { HttpError, requireUser } from './auth.js';
import { getOwnedPost } from './campaign-store.js';
import { getOwnedSocialAccount, publishCampaignPost } from './publisher.js';
import { registerMetaOAuthRoutes } from './social-meta.js';
import { registerXOAuthRoutes } from './social-x.js';
import type { Env } from './types.js';

type AppEnv = { Bindings: Env };

export const socialRoutes = new Hono<AppEnv>();

socialRoutes.get('/social/providers', (c) => {
  return c.json({
    providers: [
      { id: 'facebook', name: 'Facebook Pages', status: 'oauth-ready', capabilities: ['text', 'link'] },
      {
        id: 'instagram',
        name: 'Instagram Business/Creator',
        status: 'account-discovery-ready',
        capabilities: ['image'],
      },
      { id: 'x', name: 'X (Twitter)', status: 'oauth-ready', capabilities: ['text', 'image', 'link'] },
    ],
  });
});

socialRoutes.get('/social/accounts', async (c) => {
  const user = await requireUser(c);
  const rows = await c.env.DB.prepare(
    `SELECT id, provider, account_id, page_id, display_name, scopes, token_expires_at, status, created_at, updated_at
     FROM social_accounts WHERE user_id = ? ORDER BY provider, display_name`,
  )
    .bind(user.uid)
    .all<{
      id: string;
      provider: string;
      account_id: string;
      page_id: string | null;
      display_name: string;
      scopes: string;
      token_expires_at: string | null;
      status: string;
      created_at: string;
      updated_at: string;
    }>();

  return c.json({
    accounts: rows.results.map((row) => ({
      id: row.id,
      provider: row.provider,
      accountId: row.account_id,
      pageId: row.page_id,
      displayName: row.display_name,
      scopes: JSON.parse(row.scopes || '[]'),
      tokenExpiresAt: row.token_expires_at,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  });
});

// Delete a connected social account
socialRoutes.delete('/social/accounts/:id', async (c) => {
  const user = await requireUser(c);
  const account = await getOwnedSocialAccount(c.env, c.req.param('id'), user.uid);
  await c.env.DB.prepare('DELETE FROM social_accounts WHERE id = ? AND user_id = ?')
    .bind(account.id, user.uid)
    .run();
  return c.json({ ok: true });
});

registerMetaOAuthRoutes(socialRoutes);
registerXOAuthRoutes(socialRoutes);

socialRoutes.post('/posts/:id/publish-now', async (c) => {
  const user = await requireUser(c);
  const post = await getOwnedPost(c.env, c.req.param('id'), user.uid);
  if (post.approval_status !== 'approved') throw new HttpError('post must be approved before publishing', 409);
  if (post.status === 'published' && post.external_post_id) {
    return c.json({
      ok: true,
      alreadyPublished: true,
      externalPostId: post.external_post_id,
      permalink: post.external_permalink,
    });
  }

  const body = await c.req
    .json<{ socialAccountId?: string; linkUrl?: string; mediaUrl?: string }>()
    .catch((): { socialAccountId?: string; linkUrl?: string; mediaUrl?: string } => ({}));
  const accountId = body.socialAccountId || post.social_account_id;
  if (!accountId) throw new HttpError('socialAccountId is required for manual publish', 400);

  const account = await getOwnedSocialAccount(c.env, accountId, user.uid);
  const result = await publishCampaignPost(c.env, post, account, {
    source: 'manual',
    linkUrl: body.linkUrl ?? null,
    mediaUrl: body.mediaUrl ?? null,
  });
  return c.json({
    ok: true,
    alreadyPublished: result.alreadyPublished,
    externalPostId: result.externalPostId,
    permalink: result.externalPermalink ?? null,
  });
});
