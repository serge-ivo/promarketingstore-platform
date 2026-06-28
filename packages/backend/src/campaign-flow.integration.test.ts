import { describe, expect, it } from 'vitest';
import { createSession } from './auth.js';
import app from './index.js';
import type { Env } from './types.js';

const SECRET = 'test-secret';

class FakeD1 {
  campaigns = new Map<string, Record<string, unknown>>();
  runs: Array<Record<string, unknown>> = [];
  posts: Array<Record<string, unknown>> = [];
  events: Array<Record<string, unknown>> = [];

  prepare(sql: string) {
    return new Statement(this, sql);
  }
}

class Statement {
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
      return (row?.user_id === userId ? row : null) as T | null;
    }
    if (this.sql.includes('SELECT id FROM campaign_runs WHERE id = ?')) {
      const [id, campaignId, userId] = this.values;
      return (this.db.runs.find((run) => run.id === id && run.campaign_id === campaignId && run.user_id === userId) ??
        null) as T | null;
    }
    return null as T | null;
  }

  async run() {
    if (this.sql.includes('INSERT INTO campaign_runs')) {
      const [id, campaignId, userId, agentInstanceId, objective, planJson, costCap] = this.values;
      this.db.runs.push({
        id,
        campaign_id: campaignId,
        user_id: userId,
        agent_instance_id: agentInstanceId,
        objective,
        plan_json: planJson,
        status: 'draft_ready',
        cost_cap_usd: costCap,
      });
    } else if (this.sql.includes('INSERT INTO campaign_posts')) {
      const [id, campaignId, runId, userId, provider, postType, body, scheduledAt, idempotencyKey] = this.values;
      this.db.posts.push({
        id,
        campaign_id: campaignId,
        run_id: runId,
        user_id: userId,
        provider,
        post_type: postType,
        body,
        scheduled_at: scheduledAt,
        status: 'draft',
        approval_status: 'pending',
        idempotency_key: idempotencyKey,
      });
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
    } else if (this.sql.includes('INSERT INTO agent_events')) {
      const [id, campaignId, runId, userId, eventType, payloadJson] = this.values;
      this.db.events.push({ id, campaignId, runId, userId, eventType, payloadJson });
    }
    return { meta: { changes: 1 } };
  }
}

async function authHeader() {
  const token = await createSession({ uid: 'google:123', email: 'u@example.com' }, SECRET);
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
  };
}

describe('campaign planning integration', () => {
  it('plans and approves a campaign run through HTTP routes', async () => {
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

    const planResponse = await app.fetch(
      new Request('https://api.test/v1/campaigns/camp_1/agent/plan', {
        method: 'POST',
        headers: await authHeader(),
      }),
      env(db),
    );
    const plan = (await planResponse.json()) as { runId: string };

    const approveResponse = await app.fetch(
      new Request(`https://api.test/v1/campaigns/camp_1/runs/${plan.runId}/approve`, {
        method: 'POST',
        headers: await authHeader(),
      }),
      env(db),
    );

    expect(planResponse.status).toBe(201);
    expect(approveResponse.status).toBe(200);
    expect(db.runs[0]?.status).toBe('approved');
    expect(db.posts.every((post) => post.approval_status === 'approved')).toBe(true);
  });
});
