import { describe, expect, it } from 'vitest';
import { HttpError } from './auth.js';
import { appendAgentEvent, getOwnedCampaign, serializeCampaign } from './campaign-store.js';
import type { Env } from './types.js';

class Statement {
  private values: unknown[] = [];

  constructor(
    private readonly sql: string,
    private readonly db: FakeD1,
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
    return null as T | null;
  }

  async run() {
    if (this.sql.includes('INSERT INTO agent_events')) {
      const [, campaignId, runId, userId, eventType, payloadJson] = this.values;
      this.db.events.push({ campaignId, runId, userId, eventType, payloadJson });
    }
    return { meta: { changes: 1 } };
  }
}

class FakeD1 {
  campaigns = new Map<string, Record<string, unknown>>();
  events: Array<Record<string, unknown>> = [];

  prepare(sql: string) {
    return new Statement(sql, this);
  }
}

function env(db: FakeD1): Env {
  return {
    DB: db as unknown as D1Database,
    SESSION_SIGNING_KEY: 'secret',
    GOOGLE_CLIENT_ID: 'gid',
    GOOGLE_CLIENT_SECRET: 'gsecret',
    CORS_ORIGIN: 'https://promarketingstore.pages.dev',
    SOCIAL_TOKEN_ENCRYPTION_KEY: 'social-secret',
  };
}

describe('campaign-store helpers', () => {
  it('loads only campaigns owned by the user', async () => {
    const db = new FakeD1();
    db.campaigns.set('camp_1', {
      id: 'camp_1',
      user_id: 'google:1',
      name: 'Launch',
      goal: null,
      audience: null,
      channels: JSON.stringify(['facebook']),
      status: 'draft',
      created_at: 'now',
      updated_at: 'now',
    });

    await expect(getOwnedCampaign(env(db), 'camp_1', 'google:2')).rejects.toMatchObject(
      new HttpError('campaign not found', 404),
    );
    expect((await getOwnedCampaign(env(db), 'camp_1', 'google:1')).name).toBe('Launch');
  });

  it('serializes channels and appends agent events', async () => {
    const db = new FakeD1();
    const serialized = serializeCampaign({
      id: 'camp_1',
      user_id: 'google:1',
      name: 'Launch',
      goal: null,
      audience: null,
      channels: JSON.stringify(['facebook']),
      status: 'draft',
      created_at: 'now',
      updated_at: 'now',
    });

    await appendAgentEvent(env(db), {
      campaignId: 'camp_1',
      runId: 'run_1',
      userId: 'google:1',
      type: 'campaign.test',
      payload: { ok: true },
    });

    expect(serialized.channels).toEqual(['facebook']);
    expect(db.events[0]?.eventType).toBe('campaign.test');
  });
});
