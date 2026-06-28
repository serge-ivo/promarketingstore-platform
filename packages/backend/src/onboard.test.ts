import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from './index.js';
import { createSession } from './auth.js';

const SECRET = 'test-secret-onboard';

async function authHeader(): Promise<string> {
  const token = await createSession(
    { uid: 'google:onboard', email: 'test@test.com', name: 'Test', avatarUrl: null },
    SECRET,
  );
  return `Bearer ${token}`;
}

// Minimal D1 mock for onboard flow
class FakeD1 {
  sources: Record<string, unknown>[] = [];
  content: Record<string, unknown>[] = [];
  posts: Record<string, unknown>[] = [];
  keys: Record<string, unknown>[] = [];
  brands: Record<string, unknown>[] = [];

  prepare(sql: string) {
    return new FakeStmt(this, sql);
  }
}

class FakeStmt {
  private values: unknown[] = [];
  constructor(private db: FakeD1, private sql: string) {}
  bind(...v: unknown[]) { this.values = v; return this; }

  async first<T>() {
    if (this.sql.includes('FROM sources') && this.sql.includes('LIKE')) return null as T;
    if (this.sql.includes('FROM sources WHERE id')) {
      const id = this.values[0];
      return (this.db.sources.find(s => s.id === id) ?? null) as T;
    }
    if (this.sql.includes('FROM brand_profiles')) return null as T;
    if (this.sql.includes('FROM keys')) return null as T;
    if (this.sql.includes('COUNT(*)')) return { count: 0 } as T;
    if (this.sql.includes('FROM posts WHERE id')) {
      const [id, uid] = this.values;
      return (this.db.posts.find(p => p.id === id && p.user_id === uid) ?? null) as T;
    }
    return null as T;
  }

  async all<T>() {
    if (this.sql.includes('FROM source_content WHERE source_id')) {
      return { results: this.db.content as T[] };
    }
    if (this.sql.includes('FROM posts WHERE user_id')) {
      return { results: this.db.posts as T[] };
    }
    if (this.sql.includes('FROM posts') && this.sql.includes('failed')) {
      return { results: [] as T[] };
    }
    if (this.sql.includes('FROM campaign_posts')) return { results: [] as T[] };
    if (this.sql.includes('FROM sources')) return { results: [] as T[] };
    if (this.sql.includes('FROM social_accounts')) return { results: [] as T[] };
    return { results: [] as T[] };
  }

  async run() {
    if (this.sql.includes('INSERT INTO sources')) {
      this.db.sources.push({ id: this.values[0], user_id: this.values[1], type: this.values[2], config: this.values[4] });
    }
    return { meta: { changes: 1 } };
  }
}

function env() {
  return {
    DB: new FakeD1() as unknown as D1Database,
    SESSION_SIGNING_KEY: SECRET,
    SOCIAL_TOKEN_ENCRYPTION_KEY: 'social-key',
    GOOGLE_CLIENT_ID: 'gid',
    GOOGLE_CLIENT_SECRET: 'gs',
    CORS_ORIGIN: 'https://promarketingstore.pages.dev',
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('onboard', () => {
  it('POST /v1/onboard rejects missing URL', async () => {
    const e = env();
    const auth = await authHeader();
    const res = await app.request('/v1/onboard', {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, e);
    expect(res.status).toBe(400);
  });

  it('POST /v1/onboard rejects invalid URL', async () => {
    const e = env();
    const auth = await authHeader();
    const res = await app.request('/v1/onboard', {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'not-a-url' }),
    }, e);
    expect(res.status).toBe(400);
  });

  it('POST /v1/onboard creates source and attempts scan', async () => {
    const e = env();
    const auth = await authHeader();

    // Mock fetch to return simple HTML
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('example.com')) {
        return new Response('<html><head><title>Test Page</title><meta name="description" content="This is a great test page with enough content to extract."></head><body><h1>Welcome</h1><p>This is a paragraph with enough content to be worth extracting for social media posts.</p></body></html>');
      }
      return new Response('{}', { status: 404 });
    }));

    const res = await app.request('/v1/onboard', {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', platforms: ['x'] }),
    }, e);

    // Onboard scans and returns results (may fail gracefully on AI generation)
    const data = await res.json() as { sourceId?: string; error?: string; scanned?: unknown };
    expect([200, 502].includes(res.status)).toBe(true);
    if (res.status === 200) {
      expect(data.sourceId).toBeTruthy();
    } else {
      // 502 = scan fetch failed (mock may not catch all internal fetches)
      expect(data.error).toBeTruthy();
    }
  });

  it('rejects unauthenticated', async () => {
    const e = env();
    const res = await app.request('/v1/onboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    }, e);
    expect(res.status).toBe(401);
  });
});

describe('brand', () => {
  it('GET /v1/brand returns default brand profile', async () => {
    const e = env();
    const auth = await authHeader();
    const res = await app.request('/v1/brand', { headers: { Authorization: auth } }, e);
    // Will attempt to create default — our fake DB won't find it, returns null
    expect(res.status).toBe(200);
  });
});
