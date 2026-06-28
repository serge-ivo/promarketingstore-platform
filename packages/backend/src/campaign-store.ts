import { HttpError } from './auth.js';
import { parseChannels } from './planner.js';
import type { Env } from './types.js';

export interface CampaignRow {
  id: string;
  user_id: string;
  name: string;
  goal: string | null;
  audience: string | null;
  channels: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface CampaignPostRow {
  id: string;
  campaign_id: string;
  run_id: string | null;
  user_id: string;
  provider: string;
  social_account_id: string | null;
  post_type: string;
  body: string;
  media_r2_key: string | null;
  scheduled_at: string | null;
  status: string;
  approval_status: string;
  idempotency_key: string;
  external_post_id: string | null;
  external_permalink: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
}

export async function getOwnedCampaign(env: Env, id: string, userId: string): Promise<CampaignRow> {
  const row = await env.DB.prepare(
    'SELECT id, user_id, name, goal, audience, channels, status, created_at, updated_at FROM campaigns WHERE id = ? AND user_id = ?',
  )
    .bind(id, userId)
    .first<CampaignRow>();
  if (!row) throw new HttpError('campaign not found', 404);
  return row;
}

export function serializeCampaign(row: CampaignRow) {
  return {
    ...row,
    channels: parseChannels(row.channels),
  };
}

export async function appendAgentEvent(
  env: Env,
  input: {
    campaignId: string;
    runId?: string | null;
    userId: string;
    type: string;
    payload: unknown;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO agent_events (id, campaign_id, run_id, user_id, event_type, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(
      crypto.randomUUID(),
      input.campaignId,
      input.runId ?? null,
      input.userId,
      input.type,
      JSON.stringify(input.payload),
    )
    .run();
}

export async function getOwnedPost(env: Env, postId: string, userId: string): Promise<CampaignPostRow> {
  const row = await env.DB.prepare(
    `SELECT id, campaign_id, run_id, user_id, provider, social_account_id, post_type, body,
            media_r2_key, scheduled_at, status, approval_status, idempotency_key,
            external_post_id, external_permalink, last_error_code, last_error_message,
            created_at, updated_at
     FROM campaign_posts WHERE id = ? AND user_id = ?`,
  )
    .bind(postId, userId)
    .first<CampaignPostRow>();
  if (!row) throw new HttpError('post not found', 404);
  return row;
}
