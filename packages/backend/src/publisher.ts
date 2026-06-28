import { MetaOrganicAdapter, XAdapter, type SocialProvider } from '@pms/social';
import { HttpError } from './auth.js';
import { appendAgentEvent, type CampaignPostRow } from './campaign-store.js';
import { decryptSecret } from './secret-crypto.js';
import { metaGraph, requireSocialTokenKey } from './social-meta.js';
import { refreshXToken } from './social-x.js';
import type { Env } from './types.js';

export interface SocialAccountRow {
  id: string;
  user_id: string;
  provider: SocialProvider;
  account_id: string;
  page_id: string | null;
  display_name: string;
  access_token_encrypted: string;
  access_token_iv: string;
  refresh_token_encrypted: string | null;
  refresh_token_iv: string | null;
  scopes: string;
  token_expires_at: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface PublishOptions {
  linkUrl?: string | null;
  mediaUrl?: string | null;
  source: 'manual' | 'scheduled';
}

function providerPostType(account: SocialAccountRow, options: PublishOptions): 'text' | 'image' | 'link' {
  if (account.provider === 'instagram') return 'image';
  if (options.mediaUrl) return 'image';
  if (options.linkUrl) return 'link';
  return 'text';
}

type SupportedProvider = 'facebook' | 'instagram' | 'x';
const SUPPORTED_PROVIDERS: SupportedProvider[] = ['facebook', 'instagram', 'x'];

function providerFromAccount(account: SocialAccountRow): SupportedProvider {
  if (SUPPORTED_PROVIDERS.includes(account.provider as SupportedProvider)) {
    return account.provider as SupportedProvider;
  }
  throw new HttpError(`provider ${account.provider} is not supported for organic publishing`, 409);
}

/** Resolve the access token for an account, auto-refreshing expired X tokens. */
async function resolveAccessToken(env: Env, account: SocialAccountRow): Promise<string> {
  if (
    account.provider === 'x' &&
    account.refresh_token_encrypted &&
    account.refresh_token_iv &&
    account.token_expires_at &&
    Date.parse(account.token_expires_at) < Date.now() + 5 * 60 * 1000
  ) {
    try {
      const refreshed = await refreshXToken(env, {
        id: account.id,
        refresh_token_encrypted: account.refresh_token_encrypted,
        refresh_token_iv: account.refresh_token_iv,
      });
      return refreshed.accessToken;
    } catch {
      // Fallback to existing token
    }
  }
  return decryptSecret(account.access_token_encrypted, account.access_token_iv, requireSocialTokenKey(env));
}

function createAdapter(env: Env, provider: SupportedProvider) {
  if (provider === 'x') return new XAdapter();
  return new MetaOrganicAdapter(metaGraph(env));
}

export async function publishCampaignPost(
  env: Env,
  post: CampaignPostRow,
  account: SocialAccountRow,
  options: PublishOptions,
) {
  if (post.approval_status !== 'approved') throw new HttpError('post must be approved before publishing', 409);
  if (account.status !== 'connected') throw new HttpError('social account is not connected', 409);
  if (post.status === 'published' && post.external_post_id) {
    return {
      alreadyPublished: true,
      externalPostId: post.external_post_id,
      externalPermalink: post.external_permalink,
    };
  }

  const provider = providerFromAccount(account);
  if (provider === 'instagram' && !options.mediaUrl) {
    throw new HttpError('Instagram publishing requires a public mediaUrl', 409);
  }

  const accessToken = await resolveAccessToken(env, account);
  const adapter = createAdapter(env, provider);

  await env.DB.prepare(
    `UPDATE campaign_posts SET status = 'publishing', social_account_id = ?, updated_at = datetime('now')
     WHERE id = ? AND user_id = ?`,
  )
    .bind(account.id, post.id, post.user_id)
    .run();

  try {
    const result = await adapter.publish({
      postId: post.id,
      provider,
      account: {
        id: account.id,
        provider,
        accountId: account.account_id,
        pageId: account.page_id,
        displayName: account.display_name,
        accessToken,
      },
      postType: providerPostType(account, options),
      body: post.body,
      mediaUrl: options.mediaUrl ?? null,
      linkUrl: options.linkUrl ?? null,
      idempotencyKey: post.idempotency_key,
    });

    await env.DB.prepare(
      `INSERT INTO post_attempts (id, post_id, provider, request_json, response_json, success, created_at)
       VALUES (?, ?, ?, ?, ?, 1, datetime('now'))`,
    )
      .bind(
        crypto.randomUUID(),
        post.id,
        provider,
        JSON.stringify({
          postId: post.id,
          socialAccountId: account.id,
          postType: providerPostType(account, options),
          source: options.source,
        }),
        JSON.stringify(result.rawResponse),
      )
      .run();
    await env.DB.prepare(
      `UPDATE campaign_posts
       SET status = 'published', external_post_id = ?, external_permalink = ?, last_error_code = NULL,
           last_error_message = NULL, updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`,
    )
      .bind(result.externalPostId, result.externalPermalink ?? null, post.id, post.user_id)
      .run();
    await appendAgentEvent(env, {
      campaignId: post.campaign_id,
      runId: post.run_id,
      userId: post.user_id,
      type: 'campaign.post.published',
      payload: { postId: post.id, provider, externalPostId: result.externalPostId, source: options.source },
    });

    return {
      alreadyPublished: false,
      externalPostId: result.externalPostId,
      externalPermalink: result.externalPermalink ?? null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'publish failed';
    await env.DB.prepare(
      `INSERT INTO post_attempts (id, post_id, provider, request_json, response_json, success, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, datetime('now'))`,
    )
      .bind(
        crypto.randomUUID(),
        post.id,
        provider,
        JSON.stringify({ postId: post.id, socialAccountId: account.id, source: options.source }),
        JSON.stringify({ error: message }),
        message,
      )
      .run();
    await env.DB.prepare(
      `UPDATE campaign_posts
       SET status = 'failed', last_error_code = 'provider_error', last_error_message = ?, updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`,
    )
      .bind(message, post.id, post.user_id)
      .run();
    throw new HttpError(message, 502);
  }
}

export async function getOwnedSocialAccount(env: Env, accountId: string, userId: string): Promise<SocialAccountRow> {
  const account = await env.DB.prepare(
    `SELECT id, user_id, provider, account_id, page_id, display_name, access_token_encrypted, access_token_iv,
            refresh_token_encrypted, refresh_token_iv, scopes, token_expires_at, status, created_at, updated_at
     FROM social_accounts WHERE id = ? AND user_id = ?`,
  )
    .bind(accountId, userId)
    .first<SocialAccountRow>();
  if (!account) throw new HttpError('social account not found', 404);
  return account;
}
