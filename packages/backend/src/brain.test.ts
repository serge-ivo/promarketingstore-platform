import { describe, expect, it } from 'vitest';
import { createSession } from './auth.js';
import app from './index.js';
import type { Env } from './types.js';

const SECRET = 'test-secret';

class Statement {
  private values: unknown[] = [];

  constructor(private readonly db: FakeD1) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>() {
    const [id, userId] = this.values;
    const row = this.db.campaigns.get(String(id));
    return (row?.user_id === userId ? row : null) as T | null;
  }
}

class FakeD1 {
  campaigns = new Map<string, Record<string, unknown>>();

  prepare() {
    return new Statement(this);
  }
}

async function authHeader(userId = 'google:123') {
  const token = await createSession({ uid: userId, email: 'u@example.com', name: 'User' }, SECRET);
  return { Authorization: `Bearer ${token}` };
}

function env(db: FakeD1, calls: Request[]): Env {
  return {
    DB: db as unknown as D1Database,
    SESSION_SIGNING_KEY: SECRET,
    GOOGLE_CLIENT_ID: 'gid',
    GOOGLE_CLIENT_SECRET: 'gsecret',
    CORS_ORIGIN: 'https://promarketingstore.pages.dev',
    SOCIAL_TOKEN_ENCRYPTION_KEY: 'social-secret',
    INTERNAL_TOKEN: 'internal-secret',
    AGENT_BRAIN: {
      fetch: async (request: Request) => {
        calls.push(request);
        return Response.json({ ok: true, path: new URL(request.url).pathname });
      },
    } as Fetcher,
  };
}

describe('brain proxy routes', () => {
  it('forwards owned campaign state requests through the service binding', async () => {
    const db = new FakeD1();
    const calls: Request[] = [];
    db.campaigns.set('camp_1', {
      id: 'camp_1',
      user_id: 'google:123',
      name: 'Launch',
      goal: null,
      audience: null,
      channels: '[]',
      status: 'draft',
      created_at: 'now',
      updated_at: 'now',
    });

    const response = await app.fetch(
      new Request('https://api.test/v1/campaigns/camp_1/brain', {
        headers: await authHeader(),
      }),
      env(db, calls),
    );
    const body = (await response.json()) as { ok: boolean; path: string };

    expect(response.status).toBe(200);
    expect(body.path).toBe('/v1/campaigns/camp_1/brain/state');
    expect(calls[0]?.headers.get('X-Internal-Token')).toBe('internal-secret');
  });

  it('blocks brain access for campaigns owned by another user', async () => {
    const db = new FakeD1();
    const calls: Request[] = [];
    db.campaigns.set('camp_1', { id: 'camp_1', user_id: 'google:other' });

    const response = await app.fetch(
      new Request('https://api.test/v1/campaigns/camp_1/brain', {
        headers: await authHeader(),
      }),
      env(db, calls),
    );

    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});
