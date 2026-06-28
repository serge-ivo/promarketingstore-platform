import { describe, expect, it } from 'vitest';
import { createSession } from './auth.js';
import app from './index.js';
import type { Env } from './types.js';

const SECRET = 'test-secret';

interface CampaignRecord {
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

class FakeD1 {
  campaigns = new Map<string, CampaignRecord>();
  runs: Array<Record<string, unknown>> = [];
  posts: Array<Record<string, unknown>> = [];
  events: Array<Record<string, unknown>> = [];
  oauthStates: Array<Record<string, unknown>> = [];
  socialAccounts: Array<Record<string, unknown>> = [];

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }
}

class FakeStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>() {
    if (this.sql.includes('FROM campaigns WHERE id = ? AND user_id = ?')) {
      const [id, userId] = this.values;
      const row = this.db.campaigns.get(String(id));
      return (row && row.user_id === userId ? row : null) as T | null;
    }
    if (this.sql.includes('FROM campaign_runs') && this.sql.includes('ORDER BY created_at DESC LIMIT 1')) {
      const [campaignId, userId] = this.values;
      return (this.db.runs.find((run) => run.campaign_id === campaignId && run.user_id === userId) ?? null) as T | null;
    }
    if (this.sql.includes('FROM campaign_posts WHERE id = ? AND user_id = ?')) {
      const [postId, userId] = this.values;
      return (this.db.posts.find((post) => post.id === postId && post.user_id === userId) ?? null) as T | null;
    }
    if (this.sql.includes('FROM social_accounts WHERE id = ? AND user_id = ?')) {
      const [accountId, userId] = this.values;
      return (this.db.socialAccounts.find((account) => account.id === accountId && account.user_id === userId) ??
        null) as T | null;
    }
    return null as T | null;
  }

  async all<T>() {
    if (this.sql.includes('FROM campaign_posts WHERE campaign_id = ? AND user_id = ?')) {
      const [campaignId, userId] = this.values;
      return {
        results: this.db.posts.filter((post) => post.campaign_id === campaignId && post.user_id === userId) as T[],
      };
    }
    return { results: [] as T[] };
  }

  async run() {
    if (this.sql.includes('INSERT INTO campaign_runs')) {
      const [id, campaignId, userId, agentInstanceId, objective, planJson, costCap] = this.values;
      this.db.runs.push({
        id,
        campaign_id: campaignId,
        user_id: userId,
        agent_instance_id: agentInstanceId,
        workflow_instance_id: null,
        objective,
        plan_json: planJson,
        status: 'draft_ready',
        autopilot_level: 'approve_first',
        cost_cap_usd: costCap,
        cost_spent_usd: 0,
      });
    } else if (this.sql.includes('INSERT INTO campaign_posts')) {
      const [id, campaignId, runId, userId, provider, postType, body, scheduledAt, idempotencyKey] = this.values;
      this.db.posts.push({
        id,
        campaign_id: campaignId,
        run_id: runId,
        user_id: userId,
        provider,
        social_account_id: null,
        post_type: postType,
        body,
        scheduled_at: scheduledAt,
        status: 'draft',
        approval_status: 'pending',
        idempotency_key: idempotencyKey,
      });
    } else if (this.sql.includes('INSERT INTO agent_events')) {
      const [id, campaignId, runId, userId, eventType, payloadJson] = this.values;
      this.db.events.push({
        id,
        campaign_id: campaignId,
        run_id: runId,
        user_id: userId,
        event_type: eventType,
        payload_json: payloadJson,
      });
    } else if (this.sql.includes('INSERT INTO oauth_states')) {
      const [id, userId, returnTo, expiresAt] = this.values;
      this.db.oauthStates.push({ id, user_id: userId, provider: 'meta', return_to: returnTo, expires_at: expiresAt });
    } else if (this.sql.includes("UPDATE campaign_posts\n     SET approval_status = 'approved'")) {
      const [runId, userId] = this.values;
      for (const post of this.db.posts) {
        if (post.run_id === runId && post.user_id === userId && post.status === 'draft') {
          post.status = 'approved';
          post.approval_status = 'approved';
        }
      }
    } else if (this.sql.includes("UPDATE campaign_runs SET status = 'approved'")) {
      const [runId, userId] = this.values;
      for (const run of this.db.runs) {
        if (run.id === runId && run.user_id === userId) run.status = 'approved';
      }
    } else if (this.sql.includes('UPDATE campaign_posts') && this.sql.includes('SET body = ?')) {
      const [body, scheduledAt, status, approvalStatus, socialAccountId, mediaKey, postId, userId] = this.values;
      const post = this.db.posts.find((row) => row.id === postId && row.user_id === userId);
      if (post) {
        post.body = body;
        post.scheduled_at = scheduledAt;
        post.status = status;
        post.approval_status = approvalStatus;
        post.social_account_id = socialAccountId;
        post.media_r2_key = mediaKey;
      }
    }
    return { meta: { changes: 1 } };
  }
}

async function authHeader(userId = 'google:123') {
  const token = await createSession({ uid: userId, email: 'u@example.com', name: 'User' }, SECRET);
  return { Authorization: `Bearer ${token}` };
}

function env(db: FakeD1): Env {
  return {
    DB: db as unknown as D1Database,
    SESSION_SIGNING_KEY: SECRET,
    GOOGLE_CLIENT_ID: 'gid',
    GOOGLE_CLIENT_SECRET: 'gsecret',
    CORS_ORIGIN: 'https://promarketingstore.pages.dev',
    SOCIAL_TOKEN_ENCRYPTION_KEY: 'social-secret',
    META_APP_ID: 'meta-app',
    META_APP_SECRET: 'meta-secret',
  };
}

describe('campaign control-plane routes', () => {
  it('creates a run and draft posts for an owned campaign', async () => {
    const db = new FakeD1();
    db.campaigns.set('camp_1', {
      id: 'camp_1',
      user_id: 'google:123',
      name: 'Launch',
      goal: 'get beta users',
      audience: 'founders',
      channels: JSON.stringify(['facebook']),
      status: 'draft',
      created_at: 'now',
      updated_at: 'now',
    });

    const response = await app.fetch(
      new Request('https://api.test/v1/campaigns/camp_1/agent/plan', {
        method: 'POST',
        headers: { ...(await authHeader()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ costCapUsd: 12 }),
      }),
      env(db),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { runId: string; status: string };
    expect(body.status).toBe('draft_ready');
    expect(db.runs).toHaveLength(1);
    expect(db.posts).toHaveLength(3);
    expect(db.events[0]?.event_type).toBe('campaign.plan.created');
  });

  it('blocks campaign planning for a different owner', async () => {
    const db = new FakeD1();
    db.campaigns.set('camp_1', {
      id: 'camp_1',
      user_id: 'google:other',
      name: 'Launch',
      goal: null,
      audience: null,
      channels: '[]',
      status: 'draft',
      created_at: 'now',
      updated_at: 'now',
    });

    const response = await app.fetch(
      new Request('https://api.test/v1/campaigns/camp_1/agent/plan', {
        method: 'POST',
        headers: await authHeader(),
      }),
      env(db),
    );

    expect(response.status).toBe(404);
    expect(db.runs).toHaveLength(0);
  });

  it('creates a Meta OAuth URL and stores one-time state', async () => {
    const db = new FakeD1();

    const response = await app.fetch(
      new Request('https://api.test/v1/social/meta/oauth/start', {
        method: 'POST',
        headers: { ...(await authHeader()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnTo: 'https://promarketingstore.pages.dev/console/' }),
      }),
      env(db),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { authUrl: string; state: string };
    const authUrl = new URL(body.authUrl);
    expect(authUrl.hostname).toBe('www.facebook.com');
    expect(authUrl.searchParams.get('client_id')).toBe('meta-app');
    expect(authUrl.searchParams.get('scope')).toContain('pages_manage_posts');
    expect(db.oauthStates).toHaveLength(1);
    expect(db.oauthStates[0]?.id).toBe(body.state);
  });

  it('refuses to publish an unapproved post', async () => {
    const db = new FakeD1();
    db.posts.push({
      id: 'post_1',
      campaign_id: 'camp_1',
      run_id: 'run_1',
      user_id: 'google:123',
      provider: 'facebook',
      social_account_id: null,
      post_type: 'text',
      body: 'Draft',
      media_r2_key: null,
      scheduled_at: null,
      status: 'draft',
      approval_status: 'pending',
      idempotency_key: 'idem',
      external_post_id: null,
      external_permalink: null,
      last_error_code: null,
      last_error_message: null,
      created_at: 'now',
      updated_at: 'now',
    });

    const response = await app.fetch(
      new Request('https://api.test/v1/posts/post_1/publish-now', {
        method: 'POST',
        headers: await authHeader(),
      }),
      env(db),
    );

    expect(response.status).toBe(409);
  });

  it('schedules an approved post onto a connected social account', async () => {
    const db = new FakeD1();
    db.socialAccounts.push({
      id: 'acct_1',
      user_id: 'google:123',
      provider: 'facebook',
      account_id: 'page_1',
      page_id: null,
      display_name: 'Main Page',
      access_token_encrypted: 'cipher',
      access_token_iv: 'iv',
      scopes: '[]',
      token_expires_at: null,
      status: 'connected',
      created_at: 'now',
      updated_at: 'now',
    });
    db.posts.push({
      id: 'post_1',
      campaign_id: 'camp_1',
      run_id: 'run_1',
      user_id: 'google:123',
      provider: 'facebook',
      social_account_id: null,
      post_type: 'text',
      body: 'Draft',
      media_r2_key: null,
      scheduled_at: null,
      status: 'draft',
      approval_status: 'pending',
      idempotency_key: 'idem',
      external_post_id: null,
      external_permalink: null,
      last_error_code: null,
      last_error_message: null,
      created_at: 'now',
      updated_at: 'now',
    });

    const response = await app.fetch(
      new Request('https://api.test/v1/posts/post_1', {
        method: 'PATCH',
        headers: { ...(await authHeader()), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'scheduled',
          scheduledAt: '2026-06-21T09:00:00.000Z',
          socialAccountId: 'acct_1',
        }),
      }),
      env(db),
    );

    expect(response.status).toBe(200);
    expect(db.posts[0]).toMatchObject({
      status: 'scheduled',
      approval_status: 'approved',
      social_account_id: 'acct_1',
      scheduled_at: '2026-06-21T09:00:00.000Z',
    });
    expect(db.events.at(-1)?.event_type).toBe('campaign.post.updated');
  });
});
