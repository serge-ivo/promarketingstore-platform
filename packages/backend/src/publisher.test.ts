import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CampaignPostRow } from './campaign-store.js';
import { publishCampaignPost } from './publisher.js';
import { publishDuePosts } from './scheduled-publisher.js';
import { encryptSecret } from './secret-crypto.js';
import type { Env } from './types.js';

const SOCIAL_KEY = 'strong-test-social-key';

type SocialAccountRecord = {
  id: string;
  user_id: string;
  provider: 'facebook' | 'instagram';
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
};

class FakeD1 {
  accounts: SocialAccountRecord[] = [];
  posts: CampaignPostRow[] = [];
  attempts: Array<Record<string, unknown>> = [];
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
    if (this.sql.includes('FROM social_accounts WHERE id = ? AND user_id = ?')) {
      const [accountId, userId] = this.values;
      return (this.db.accounts.find((account) => account.id === accountId && account.user_id === userId) ??
        null) as T | null;
    }
    return null as T | null;
  }

  async all<T>() {
    if (this.sql.includes('FROM campaign_posts') && this.sql.includes("WHERE status = 'scheduled'")) {
      const [limit] = this.values;
      const now = Date.now();
      return {
        results: this.db.posts
          .filter(
            (post) =>
              post.status === 'scheduled' &&
              post.approval_status === 'approved' &&
              post.social_account_id &&
              (!post.scheduled_at || Date.parse(post.scheduled_at) <= now),
          )
          .slice(0, Number(limit)) as T[],
      };
    }
    return { results: [] as T[] };
  }

  async run() {
    if (this.sql.includes("SET status = 'publishing'")) {
      const [accountId, postId, userId] = this.values;
      const post = this.findPost(postId, userId);
      if (post) {
        post.status = 'publishing';
        post.social_account_id = String(accountId);
      }
    } else if (this.sql.includes('INSERT INTO post_attempts')) {
      this.insertAttempt();
    } else if (this.sql.includes("SET status = 'published'")) {
      const [externalPostId, permalink, postId, userId] = this.values;
      const post = this.findPost(postId, userId);
      if (post) {
        post.status = 'published';
        post.external_post_id = String(externalPostId);
        post.external_permalink = typeof permalink === 'string' ? permalink : null;
        post.last_error_code = null;
        post.last_error_message = null;
      }
    } else if (this.sql.includes("SET status = 'failed'")) {
      const [message, postId, userId] = this.values;
      const post = this.findPost(postId, userId);
      if (post) {
        post.status = 'failed';
        post.last_error_code = 'provider_error';
        post.last_error_message = String(message);
      }
    } else if (this.sql.includes('INSERT INTO agent_events')) {
      const [, campaignId, runId, userId, eventType, payloadJson] = this.values;
      this.db.events.push({
        campaign_id: campaignId,
        run_id: runId,
        user_id: userId,
        event_type: eventType,
        payloadJson,
      });
    }
    return { meta: { changes: 1 } };
  }

  private findPost(postId: unknown, userId: unknown) {
    return this.db.posts.find((post) => post.id === postId && post.user_id === userId);
  }

  private insertAttempt() {
    const [id, postId, provider, requestJson, responseJson, errorMessage] = this.values;
    this.db.attempts.push({
      id,
      post_id: postId,
      provider,
      request_json: requestJson,
      response_json: responseJson,
      success: this.sql.includes('error_message') ? 0 : 1,
      error_message: errorMessage ?? null,
    });
  }
}

function env(db: FakeD1): Env {
  return {
    DB: db as unknown as D1Database,
    SESSION_SIGNING_KEY: 'secret',
    GOOGLE_CLIENT_ID: 'gid',
    GOOGLE_CLIENT_SECRET: 'gsecret',
    CORS_ORIGIN: 'https://promarketingstore.pages.dev',
    SOCIAL_TOKEN_ENCRYPTION_KEY: SOCIAL_KEY,
    META_GRAPH_VERSION: 'v25.0',
  };
}

function post(overrides: Partial<CampaignPostRow> = {}): CampaignPostRow {
  return {
    id: 'post_1',
    campaign_id: 'camp_1',
    run_id: 'run_1',
    user_id: 'google:123',
    provider: 'facebook',
    social_account_id: 'acct_1',
    post_type: 'text',
    body: 'Launch update',
    media_r2_key: null,
    scheduled_at: new Date(Date.now() - 60_000).toISOString(),
    status: 'scheduled',
    approval_status: 'approved',
    idempotency_key: 'idem_1',
    external_post_id: null,
    external_permalink: null,
    last_error_code: null,
    last_error_message: null,
    created_at: 'now',
    updated_at: 'now',
    ...overrides,
  };
}

async function account(overrides: Partial<SocialAccountRecord> = {}): Promise<SocialAccountRecord> {
  const encrypted = await encryptSecret('page-access-token', SOCIAL_KEY);
  return {
    id: 'acct_1',
    user_id: 'google:123',
    provider: 'facebook',
    account_id: 'page_1',
    page_id: null,
    display_name: 'Main Page',
    access_token_encrypted: encrypted.ciphertext,
    access_token_iv: encrypted.iv,
    refresh_token_encrypted: null,
    refresh_token_iv: null,
    scopes: JSON.stringify(['pages_manage_posts']),
    token_expires_at: null,
    status: 'connected',
    created_at: 'now',
    updated_at: 'now',
    ...overrides,
  };
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('publisher', () => {
  it('publishes an approved Facebook post and records the attempt', async () => {
    const db = new FakeD1();
    const socialAccount = await account();
    const campaignPost = post();
    db.accounts.push(socialAccount);
    db.posts.push(campaignPost);
    const fetchMock = vi.fn(async () => jsonResponse({ id: 'fb_post_1' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishCampaignPost(env(db), campaignPost, socialAccount, {
      source: 'manual',
      linkUrl: 'https://example.com',
    });

    expect(result).toEqual({ alreadyPublished: false, externalPostId: 'fb_post_1', externalPermalink: null });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://graph.facebook.com/v25.0/page_1/feed',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(db.posts[0]?.status).toBe('published');
    expect(db.posts[0]?.external_post_id).toBe('fb_post_1');
    expect(db.attempts[0]?.success).toBe(1);
    expect(db.events[0]?.event_type).toBe('campaign.post.published');
  });

  it('marks a post failed when the provider rejects publishing', async () => {
    const db = new FakeD1();
    const socialAccount = await account();
    const campaignPost = post();
    db.accounts.push(socialAccount);
    db.posts.push(campaignPost);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { message: 'Meta rate limited' } }, { status: 429 })),
    );

    await expect(publishCampaignPost(env(db), campaignPost, socialAccount, { source: 'manual' })).rejects.toMatchObject(
      {
        status: 502,
        message: 'Meta rate limited',
      },
    );

    expect(db.posts[0]?.status).toBe('failed');
    expect(db.posts[0]?.last_error_message).toBe('Meta rate limited');
    expect(db.attempts[0]?.success).toBe(0);
  });

  it('publishes due scheduled posts and ignores future drafts', async () => {
    const db = new FakeD1();
    db.accounts.push(await account());
    db.posts.push(
      post({ id: 'due_post' }),
      post({
        id: 'future_post',
        scheduled_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      }),
      post({ id: 'draft_post', status: 'draft', approval_status: 'pending' }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ id: 'fb_due_post' })),
    );

    const summary = await publishDuePosts(env(db), 10);

    expect(summary).toEqual({ attempted: 1, published: 1, failed: 0 });
    expect(db.posts.find((row) => row.id === 'due_post')?.status).toBe('published');
    expect(db.posts.find((row) => row.id === 'future_post')?.status).toBe('scheduled');
    expect(db.posts.find((row) => row.id === 'draft_post')?.status).toBe('draft');
  });

  it('requires public media for Instagram publishing', async () => {
    const db = new FakeD1();
    const socialAccount = await account({ provider: 'instagram', account_id: 'ig_1', page_id: 'page_1' });
    const campaignPost = post({ provider: 'instagram', post_type: 'image', media_r2_key: null });

    await expect(
      publishCampaignPost(env(db), campaignPost, socialAccount, { source: 'scheduled' }),
    ).rejects.toMatchObject({
      status: 409,
      message: 'Instagram publishing requires a public mediaUrl',
    });
  });
});
