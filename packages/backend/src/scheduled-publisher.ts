import type { CampaignPostRow } from './campaign-store.js';
import { getOwnedSocialAccount, publishCampaignPost } from './publisher.js';
import type { Env } from './types.js';

type DuePostRow = CampaignPostRow & { social_account_id: string };

export async function publishDuePosts(
  env: Env,
  limit = 25,
): Promise<{ attempted: number; published: number; failed: number }> {
  const rows = await env.DB.prepare(
    `SELECT id, campaign_id, run_id, user_id, provider, social_account_id, post_type, body,
            media_r2_key, scheduled_at, status, approval_status, idempotency_key,
            external_post_id, external_permalink, last_error_code, last_error_message,
            created_at, updated_at
     FROM campaign_posts
     WHERE status = 'scheduled'
       AND approval_status = 'approved'
       AND social_account_id IS NOT NULL
       AND (scheduled_at IS NULL OR datetime(scheduled_at) <= datetime('now'))
     ORDER BY scheduled_at ASC, updated_at ASC
     LIMIT ?`,
  )
    .bind(limit)
    .all<DuePostRow>();

  let published = 0;
  let failed = 0;

  for (const post of rows.results) {
    try {
      const account = await getOwnedSocialAccount(env, post.social_account_id, post.user_id);
      const mediaUrl = post.media_r2_key?.startsWith('http') ? post.media_r2_key : null;
      const result = await publishCampaignPost(env, post, account, { source: 'scheduled', mediaUrl });
      if (!result.alreadyPublished) published++;
    } catch (err) {
      failed++;
      console.error('scheduled publish failed', post.id, err);
    }
  }

  return { attempted: rows.results.length, published, failed };
}
