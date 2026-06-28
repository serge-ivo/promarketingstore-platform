import { describe, expect, it } from 'vitest';
import { app } from './index.js';
import { createSession } from './auth.js';

const SECRET = 'test-secret-key-for-posts';
const SOCIAL_KEY = 'test-social-encryption-key';

function env() {
  return {
    DB: new FakeD1() as unknown as D1Database,
    SESSION_SIGNING_KEY: SECRET,
    SOCIAL_TOKEN_ENCRYPTION_KEY: SOCIAL_KEY,
    GOOGLE_CLIENT_ID: 'gid',
    GOOGLE_CLIENT_SECRET: 'gsecret',
    CORS_ORIGIN: 'https://promarketingstore.pages.dev',
  };
}

class FakeD1 {
  rows: Array<Record<string, unknown>> = [];

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
    if (this.sql.includes('FROM posts WHERE id = ? AND user_id = ?')) {
      const [id, userId] = this.values;
      return (this.db.rows.find((r) => r.id === id && r.user_id === userId) ?? null) as T | null;
    }
    if (this.sql.includes('FROM posts WHERE social_account_id = ? AND caption_hash = ?')) {
      return null as T | null;
    }
    if (this.sql.includes('COUNT(*)')) {
      const userId = this.values[0];
      let rows = this.db.rows.filter((r) => r.user_id === userId);
      if (this.sql.includes("status = 'scheduled'")) rows = rows.filter((r) => r.status === 'scheduled');
      if (this.sql.includes('social_accounts')) return { count: 0 } as T;
      return { count: rows.length } as T;
    }
    return null as T | null;
  }

  async all<T>() {
    if (this.sql.includes('FROM posts WHERE user_id = ?') && this.sql.includes('ORDER BY COALESCE')) {
      if (this.sql.includes('LIMIT 5')) {
        // Dashboard recent posts
        return { results: this.db.rows.slice(0, 5) as T[] };
      }
      if (this.sql.includes('scheduled_for >=')) {
        // Calendar query
        return { results: this.db.rows as T[] };
      }
      return { results: this.db.rows as T[] };
    }
    if (this.sql.includes('FROM posts WHERE user_id = ?')) {
      return { results: this.db.rows as T[] };
    }
    if (this.sql.includes('FROM posts') && this.sql.includes("status = 'scheduled'")) {
      return { results: [] as T[] };
    }
    if (this.sql.includes('FROM campaign_posts')) {
      return { results: [] as T[] };
    }
    return { results: [] as T[] };
  }

  async run() {
    if (this.sql.includes('INSERT INTO posts')) {
      const row: Record<string, unknown> = {
        id: this.values[0],
        user_id: this.values[1],
        social_account_id: this.values[2],
        platform: this.values[3],
        content: this.values[4],
        media_key: this.values[5],
        media_type: this.values[6],
        scheduled_for: this.values[7],
        status: this.values[8],
        caption_hash: this.values[9],
        posted_at: null,
        platform_post_id: null,
        error: null,
        retry_count: 0,
        campaign_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.db.rows.push(row);
    } else if (this.sql.includes('DELETE FROM posts')) {
      const [id, userId] = this.values;
      this.db.rows = this.db.rows.filter((r) => !(r.id === id && r.user_id === userId));
    }
    return { meta: { changes: 1 } };
  }
}

async function authHeader(): Promise<string> {
  const token = await createSession(
    { uid: 'google:test', email: 'test@test.com', name: 'Test', avatarUrl: null },
    SECRET,
  );
  return `Bearer ${token}`;
}

describe('posts routes', () => {
  it('POST /v1/posts creates a draft post', async () => {
    const e = env();
    const auth = await authHeader();

    const res = await app.request(
      '/v1/posts',
      {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'facebook', content: 'Hello world' }),
      },
      e,
    );

    expect(res.status).toBe(201);
    const data = (await res.json()) as { post: { platform: string; status: string; content: string } };
    expect(data.post.platform).toBe('facebook');
    expect(data.post.status).toBe('draft');
    expect(data.post.content).toBe('Hello world');
  });

  it('POST /v1/posts creates a scheduled post when scheduledFor is provided', async () => {
    const e = env();
    const auth = await authHeader();
    const scheduledFor = new Date(Date.now() + 3600_000).toISOString();

    const res = await app.request(
      '/v1/posts',
      {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'x', content: 'Future tweet', scheduledFor }),
      },
      e,
    );

    expect(res.status).toBe(201);
    const data = (await res.json()) as { post: { status: string; scheduledFor: string } };
    expect(data.post.status).toBe('scheduled');
    expect(data.post.scheduledFor).toBe(scheduledFor);
  });

  it('POST /v1/posts rejects invalid platform', async () => {
    const e = env();
    const auth = await authHeader();

    const res = await app.request(
      '/v1/posts',
      {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'snapchat', content: 'Nope' }),
      },
      e,
    );

    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain('invalid platform');
  });

  it('POST /v1/posts rejects missing content', async () => {
    const e = env();
    const auth = await authHeader();

    const res = await app.request(
      '/v1/posts',
      {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'facebook' }),
      },
      e,
    );

    expect(res.status).toBe(400);
  });

  it('GET /v1/posts returns empty list for new user', async () => {
    const e = env();
    const auth = await authHeader();

    const res = await app.request('/v1/posts', { headers: { Authorization: auth } }, e);

    expect(res.status).toBe(200);
    const data = (await res.json()) as { posts: unknown[] };
    expect(data.posts).toEqual([]);
  });

  it('DELETE /v1/posts/:id deletes a draft post', async () => {
    const e = env();
    const auth = await authHeader();
    const db = e.DB as unknown as FakeD1;
    db.rows.push({
      id: 'del-me',
      user_id: 'google:test',
      social_account_id: null,
      campaign_id: null,
      platform: 'x',
      content: 'test',
      media_key: null,
      media_type: null,
      scheduled_for: null,
      posted_at: null,
      platform_post_id: null,
      status: 'draft',
      error: null,
      retry_count: 0,
      caption_hash: 'abc',
      created_at: 'now',
      updated_at: 'now',
    });

    const res = await app.request('/v1/posts/del-me', { method: 'DELETE', headers: { Authorization: auth } }, e);

    expect(res.status).toBe(200);
    expect(db.rows.length).toBe(0);
  });

  it('DELETE /v1/posts/:id rejects deleting a published post', async () => {
    const e = env();
    const auth = await authHeader();
    const db = e.DB as unknown as FakeD1;
    db.rows.push({
      id: 'published-1',
      user_id: 'google:test',
      social_account_id: 'acct_1',
      campaign_id: null,
      platform: 'facebook',
      content: 'live',
      media_key: null,
      media_type: null,
      scheduled_for: null,
      posted_at: 'now',
      platform_post_id: 'fb_123',
      status: 'posted',
      error: null,
      retry_count: 0,
      caption_hash: 'abc',
      created_at: 'now',
      updated_at: 'now',
    });

    const res = await app.request(
      '/v1/posts/published-1',
      { method: 'DELETE', headers: { Authorization: auth } },
      e,
    );

    expect(res.status).toBe(409);
  });

  it('rejects unauthenticated requests', async () => {
    const e = env();
    const res = await app.request('/v1/posts', { method: 'GET' }, e);
    expect(res.status).toBe(401);
  });

  it('GET /v1/dashboard returns stats', async () => {
    const e = env();
    const auth = await authHeader();

    const res = await app.request('/v1/dashboard', { headers: { Authorization: auth } }, e);

    expect(res.status).toBe(200);
    const data = (await res.json()) as { connectedAccounts: number; totalPosts: number; scheduledPosts: number; recentPosts: unknown[] };
    expect(data.connectedAccounts).toBe(0);
    expect(data.totalPosts).toBe(0);
    expect(data.scheduledPosts).toBe(0);
    expect(data.recentPosts).toEqual([]);
  });

  it('GET /v1/posts/calendar returns posts for month', async () => {
    const e = env();
    const auth = await authHeader();
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const res = await app.request(`/v1/posts/calendar?month=${month}`, { headers: { Authorization: auth } }, e);

    expect(res.status).toBe(200);
    const data = (await res.json()) as { month: string; posts: unknown[] };
    expect(data.month).toBe(month);
    expect(Array.isArray(data.posts)).toBe(true);
  });

  it('GET /v1/posts/calendar rejects missing month param', async () => {
    const e = env();
    const auth = await authHeader();

    const res = await app.request('/v1/posts/calendar', { headers: { Authorization: auth } }, e);

    expect(res.status).toBe(400);
  });
});
